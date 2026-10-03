/**
 * Captures Chrome Web Store assets from the REAL extension with live data:
 *   store/screenshots/*.png   1280x800
 *   store/promo-440x280.png   from store/promo-tiles.html
 *
 *   node tests/capture-assets.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { launch, attach, shutdown } from './cdp.mjs';
import { EXT, until } from './lib.mjs';

const WATCHLIST = ['AAPL', 'NVDA', 'MSFT', 'KDP', 'ORCL', 'COST', 'MU', 'SPY'];
const OUT = path.join(EXT, 'store/screenshots');
fs.mkdirSync(OUT, { recursive: true });

const b = await launch({ width: 1280, height: 800 });
try {
  const sw = await attach(b.cdp, b.swTargetId);
  const S = (e) => b.cdp.eval(sw.sessionId, e, 60000);
  await until(async () => (await S('chrome.storage.local.get("quotes")')).quotes?.fetchedAt > 0, 90000, 500);
  await S(`chrome.storage.local.set({ symbols: ${JSON.stringify(WATCHLIST)} })`);
  await S(`new Promise((r) => chrome.runtime.onMessage.dispatch ? r() : r())`);
  // A deliberate full refresh, as if the user clicked "refresh".
  const { targetId } = await b.cdp.send('Target.createTarget', { url: `chrome-extension://${b.extId}/newtab.html` });
  const pg = await attach(b.cdp, targetId);
  const sid = pg.sessionId;
  await b.cdp.send('Page.enable', {}, sid);
  await b.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, sid);
  await b.cdp.eval(sid, `new Promise((r) => chrome.runtime.sendMessage({ type: 'refresh', reason: 'user' }, () => r(true)))`, 120000);
  const ready = await until(async () => {
    const s = await S('chrome.storage.local.get(null)');
    return WATCHLIST.every((x) => s.quotes?.data?.[x]?.price > 0 && s.meta?.[x] && 'logo' in s.meta[x] && Array.isArray(s.catalysts?.data?.[x]));
  }, 120000, 1000);
  console.log('data ready:', ready);

  const shot = async (file, clip) => {
    const { data } = await b.cdp.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) }, sid);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    console.log('wrote', path.relative(EXT, file));
  };
  const reload = async () => {
    const loaded = new Promise((r) => { const off = b.cdp.on((m) => { if (m.sessionId === sid && m.method === 'Page.loadEventFired') { off(); r(); } }); });
    await b.cdp.send('Page.reload', {}, sid);
    await loaded;
    await new Promise((r) => setTimeout(r, 2500));   // entrance animations settle
  };
  const theme = async (t) => { await S(`chrome.storage.local.get("settings").then((x) => chrome.storage.local.set({ settings: { ...x.settings, theme: '${t}' } }))`); await reload(); };

  await theme('light');
  await shot(path.join(OUT, '1-overview-light.png'));
  await theme('dark');
  await shot(path.join(OUT, '2-overview-dark.png'));

  await b.cdp.eval(sid, `document.querySelector('#hold .cell.add').click()`);
  await new Promise((r) => setTimeout(r, 400));
  await b.cdp.send('Input.insertText', { text: 'coin' }, sid);
  await until(() => b.cdp.eval(sid, `document.querySelectorAll('#sres [role=option]').length > 2`), 10000, 200);
  await new Promise((r) => setTimeout(r, 600));
  await shot(path.join(OUT, '3-search.png'));
  await b.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sid);
  await new Promise((r) => setTimeout(r, 400));

  await b.cdp.eval(sid, `document.getElementById('gear').click()`);
  await new Promise((r) => setTimeout(r, 900));
  // Opening moves keyboard focus into the panel (correct), but a focus ring in a
  // store screenshot reads as a stray highlight.
  await b.cdp.eval(sid, `document.activeElement && document.activeElement.blur()`);
  await new Promise((r) => setTimeout(r, 200));
  await shot(path.join(OUT, '4-settings.png'));

  // Promo tile, from its own HTML source.
  await b.cdp.send('Page.navigate', { url: pathToFileURL(path.join(EXT, 'store/promo-tiles.html')).href }, sid);
  await new Promise((r) => setTimeout(r, 1500));
  const box = await b.cdp.eval(sid, `(() => { const r = document.getElementById('small').getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })()`);
  await shot(path.join(EXT, 'store/promo-440x280.png'), box);
} finally {
  await shutdown(b);
}
