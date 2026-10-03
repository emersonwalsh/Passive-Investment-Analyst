/**
 * Minimal Chrome DevTools Protocol driver: launches a real Chrome with the
 * unpacked extension in a throwaway profile, no puppeteer required.
 *
 * Branded Google Chrome ignores --load-extension since v137, so this expects
 * Chrome for Testing (or Chromium). Set CHROME=/path/to/binary to choose one.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { EXT, until } from './lib.mjs';

export function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const root = path.join(os.homedir(), '.cache/puppeteer/chrome');
  const found = [];
  if (fs.existsSync(root)) {
    for (const v of fs.readdirSync(root)) {
      const bin = path.join(root, v, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
      const m = /(\d+)\.\d+\.\d+\.\d+/.exec(v);
      if (fs.existsSync(bin) && m) found.push([+m[1], bin]);
    }
  }
  found.sort((a, b) => b[0] - a[0]);
  if (!found.length) throw new Error('No Chrome for Testing found. Install one with: npx @puppeteer/browsers install chrome@stable, or set CHROME=');
  return found[0][1];
}

export class CDP {
  constructor() { this.id = 0; this.pending = new Map(); this.listeners = new Set(); }
  static async connect(url) {
    const c = new CDP();
    await new Promise((res, rej) => {
      c.ws = new WebSocket(url);
      c.ws.onopen = res;
      c.ws.onerror = () => rej(new Error('CDP websocket error'));
      c.ws.onmessage = (m) => c.#onMessage(JSON.parse(m.data));
      c.ws.onclose = () => { for (const [, p] of c.pending) p.rej(new Error('CDP closed')); c.pending.clear(); };
    });
    return c;
  }
  #onMessage(msg) {
    if (msg.id != null) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.rej(new Error(`${p.method}: ${msg.error.message}`)); else p.res(msg.result);
      return;
    }
    for (const l of this.listeners) l(msg);
  }
  send(method, params = {}, sessionId, timeout = 30000) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`CDP timeout: ${method}`)); }, timeout);
      this.pending.set(id, { method, res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  async eval(sessionId, expression, timeout = 30000) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId, timeout);
    if (r.exceptionDetails) throw new Error(`eval: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch { /* already closed */ } }
}

/** Launch Chrome with the extension; resolves once the extension worker exists. */
/**
 * Headless Chrome announces itself as "HeadlessChrome" in its user-agent, and
 * Nasdaq's bot protection resets the HTTP/2 stream for that UA on sight —
 * verified: that single header flips a 200 into ERR_HTTP2_PROTOCOL_ERROR while
 * every extension-specific header (Origin: chrome-extension://, Sec-Fetch-*)
 * passes. A headless test that keeps the default UA therefore measures nothing
 * about what real users experience, so present as the ordinary browser build.
 */
function realisticUA(bin) {
  let major = '136';
  try { major = /(\d+)\./.exec(execFileSync(bin, ['--version'], { encoding: 'utf8' }))[1]; } catch { /* keep default */ }
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

export async function launch({ headless = true, bin = findChrome(), width = 1440, height = 900 } = {}) {
  const tmpRoot = process.env.PIA_TMP || os.tmpdir();
  const profile = fs.mkdtempSync(path.join(tmpRoot, 'pia-profile-'));
  const args = [
    `--user-data-dir=${profile}`,
    `--load-extension=${EXT}`,
    `--disable-extensions-except=${EXT}`,
    '--remote-debugging-port=0',
    '--no-first-run', '--no-default-browser-check',
    // macOS: without these, Chrome can block at startup on a keychain access
    // prompt that never appears in a headless run, and the test just hangs.
    '--use-mock-keychain', '--password-store=basic',
    `--window-size=${width},${height}`,
    ...(headless ? ['--headless=new', `--user-agent=${realisticUA(bin)}`] : []),
    'about:blank',
  ];
  const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d; if (stderr.length > 20000) stderr = stderr.slice(-20000); });
  const portFile = path.join(profile, 'DevToolsActivePort');
  if (!(await until(() => fs.existsSync(portFile) && fs.readFileSync(portFile, 'utf8').includes('\n'), 30000))) {
    proc.kill('SIGKILL');
    throw new Error(`Chrome did not expose a debugging port.\n${stderr.slice(-2000)}`);
  }
  const [port, wsPath] = fs.readFileSync(portFile, 'utf8').trim().split('\n');
  const cdp = await CDP.connect(`ws://127.0.0.1:${port}${wsPath}`);
  await cdp.send('Target.setDiscoverTargets', { discover: true });

  let sw = null;
  const found = await until(async () => {
    const { targetInfos } = await cdp.send('Target.getTargets');
    sw = targetInfos.find((t) => t.type === 'service_worker' && /^chrome-extension:\/\/[a-p]{32}\/src\/background\.js$/.test(t.url));
    return Boolean(sw);
  }, 30000, 200);
  if (!found) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    await shutdown({ cdp, proc, profile });
    throw new Error(`Extension service worker never appeared. Targets: ${JSON.stringify(targetInfos.map((t) => [t.type, t.url]))}\n${stderr.slice(-2000)}`);
  }
  const version = await cdp.send('Browser.getVersion');
  return { cdp, proc, profile, extId: new URL(sw.url).host, swTargetId: sw.targetId, version: version.product, stderr: () => stderr };
}

export async function shutdown({ cdp, proc, profile }) {
  try { await cdp.send('Browser.close', {}, undefined, 5000); } catch { /* fall through to kill */ }
  cdp.close();
  await new Promise((r) => { if (proc.exitCode != null) return r(); proc.once('exit', r); setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} r(); }, 4000); });
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
}

/** Attach to a target and start collecting everything that can go wrong in it. */
export async function attach(cdp, targetId, { network = false } = {}) {
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const log = { console: [], exceptions: [], entries: [], requests: new Map(), failures: [] };
  cdp.on((m) => {
    if (m.sessionId !== sessionId) return;
    const p = m.params;
    if (m.method === 'Runtime.consoleAPICalled') log.console.push({ type: p.type, text: p.args.map((a) => a.value ?? a.description ?? a.preview?.description ?? '').join(' ') });
    else if (m.method === 'Runtime.exceptionThrown') log.exceptions.push(p.exceptionDetails.exception?.description || p.exceptionDetails.text);
    else if (m.method === 'Log.entryAdded') log.entries.push({ level: p.entry.level, source: p.entry.source, text: p.entry.text, url: p.entry.url });
    else if (m.method === 'Network.requestWillBeSent') log.requests.set(p.requestId, { url: p.request.url, t0: p.timestamp, priority: p.request.initialPriority, headers: log.pendingHeaders?.[p.requestId] || p.request.headers });
    else if (m.method === 'Network.requestWillBeSentExtraInfo') { const r = log.requests.get(p.requestId); if (r) r.headers = p.headers; else log.pendingHeaders = Object.assign(log.pendingHeaders || {}, { [p.requestId]: p.headers }); }
    else if (m.method === 'Network.responseReceived') { const r = log.requests.get(p.requestId); if (r) Object.assign(r, { status: p.response.status, protocol: p.response.protocol }); }
    else if (m.method === 'Network.loadingFinished') { const r = log.requests.get(p.requestId); if (r) r.t1 = p.timestamp; }
    else if (m.method === 'Network.loadingFailed') { const r = log.requests.get(p.requestId); log.failures.push({ url: r?.url, error: p.errorText, canceled: p.canceled }); }
  });
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Log.enable', {}, sessionId);
  if (network) await cdp.send('Network.enable', {}, sessionId);
  return { sessionId, log };
}
