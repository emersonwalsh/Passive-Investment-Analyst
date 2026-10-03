/**
 * Runs the test suites and prints one summary.
 *
 *   node tests/run.mjs            fast, offline: renderer parity (6 timezones) + service worker
 *   node tests/run.mjs --chrome   + the real extension in real Chrome, incl. worker lifetime
 *   node tests/run.mjs --package  + the real-browser suite against the zipped store upload
 *   node tests/run.mjs --live     + data accuracy against CNBC, Google Finance, stockanalysis, SEC
 *   node tests/run.mjs --all      everything, and real Chrome on every cached Chrome for Testing
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { TESTS } from './lib.mjs';

const args = new Set(process.argv.slice(2));
const all = args.has('--all');
const runs = [];
for (const tz of ['America/Los_Angeles', 'America/New_York', 'Europe/London', 'Asia/Tokyo', 'Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
  runs.push({ name: `parity (${tz})`, file: 'parity.test.mjs', env: { TZ: tz } });
}
runs.push({ name: 'quotes by session', file: 'quotes.test.mjs' });
// Real captured sessions, if any are on this machine (they are not committed).
if (fs.existsSync(path.join(TESTS, 'fixtures/local')) && fs.readdirSync(path.join(TESTS, 'fixtures/local')).some((f) => f.endsWith('.jsonl'))) {
  runs.push({ name: 'live sessions replayed', file: 'replay.test.mjs' });
}
runs.push({ name: 'service worker', file: 'worker.test.mjs' });
if (args.has('--chrome') || all) {
  runs.push({ name: 'real Chrome', file: 'chrome.test.mjs' });
  runs.push({ name: 'worker lifetime (≈4 min)', file: 'lifetime.test.mjs' });
}
if (all) {
  const root = path.join(os.homedir(), '.cache/puppeteer/chrome');
  const bins = fs.existsSync(root) ? fs.readdirSync(root).map((v) => [v, path.join(root, v, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')]).filter(([, b]) => fs.existsSync(b)) : [];
  for (const [v, bin] of bins.sort().slice(0, -1)) runs.push({ name: `real Chrome ${v}`, file: 'chrome.test.mjs', env: { CHROME: bin } });
}
if (args.has('--package') || all) {
  // Build the upload exactly as store/README.md documents, unpack it elsewhere,
  // and run the real-browser suite against THAT — so what gets submitted is
  // what was tested, not merely the folder it came from.
  const tmp = fs.mkdtempSync(path.join(process.env.PIA_TMP || os.tmpdir(), 'pia-package-'));
  const zip = path.join(tmp, 'catalyst.zip');
  const unpacked = path.join(tmp, 'unpacked');
  fs.mkdirSync(unpacked);
  const ext = path.resolve(TESTS, '../catalyst');
  const z = spawnSync('zip', ['-qr', zip, '.', '-x', 'store/*', 'README.md', '.*'], { cwd: ext, encoding: 'utf8' });
  const u = z.status === 0 ? spawnSync('unzip', ['-q', zip, '-d', unpacked], { encoding: 'utf8' }) : z;
  if (z.status !== 0 || u.status !== 0) { console.log(`could not build the package: ${z.stderr || u.stderr}`); process.exit(1); }
  const kb = Math.round(fs.statSync(zip).size / 1024);
  runs.push({ name: `store package (${kb} KB zip)`, file: 'chrome.test.mjs', env: { PIA_EXT: unpacked } });
}
if (args.has('--live') || all) runs.push({ name: 'data accuracy (live)', file: 'accuracy.test.mjs' });

const results = [];
for (const r of runs) {
  process.stdout.write(`${r.name.padEnd(34)} `);
  const t0 = Date.now();
  const p = spawnSync(process.execPath, [path.join(TESTS, r.file)], { encoding: 'utf8', env: { ...process.env, ...(r.env || {}) }, timeout: 15 * 60e3, maxBuffer: 64 * 1024 * 1024 });
  const out = `${p.stdout || ''}${p.stderr || ''}`;
  const pass = (out.match(/^\s+PASS/gm) || []).length;
  const fail = (out.match(/^\s+FAIL/gm) || []).length;
  const ok = p.status === 0 && fail === 0;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${String(pass).padStart(3)} passed  ${fail ? `${fail} failed  ` : ''}(${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  if (!ok) console.log(out.split('\n').filter((l) => /^\s+(FAIL|->)/.test(l)).slice(0, 20).join('\n') || out.slice(-2000));
  results.push({ ...r, ok, pass, fail });
}
const total = results.reduce((a, r) => a + r.pass, 0);
const bad = results.filter((r) => !r.ok);
console.log(`\n${bad.length ? `${bad.length} suite(s) failed` : 'all suites passed'} — ${total} assertions`);
process.exit(bad.length ? 1 : 0);
