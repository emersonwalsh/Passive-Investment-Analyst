/**
 * The real thing: the unpacked extension in real Chrome, fresh profile, real
 * network. No stubs anywhere. This is the closest a test gets to a brand-new
 * user installing from the store.
 *
 *   node tests/chrome.test.mjs            (newest Chrome for Testing found)
 *   CHROME=/path/to/chrome node tests/chrome.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { launch, attach, shutdown } from './cdp.mjs';
import { EXT, check, section, done, until } from './lib.mjs';

const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0 Safari/537.36';

// Runs before any page script. CDP-injected, so the page CSP does not apply.
const INSTRUMENT = `(() => {
  const P = window.__pia = { cls: 0, shifts: [], csp: [], errors: [], writes: [] };
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) {
      P.cls += e.value;
      P.shifts.push({ v: +e.value.toFixed(4), t: Math.round(e.startTime), src: (e.sources || []).map((s) => s.node ? (s.node.id || s.node.className || s.node.nodeName) : '?') });
    } }).observe({ type: 'layout-shift', buffered: true });
  } catch (e) { P.errors.push('observer: ' + e.message); }
  document.addEventListener('securitypolicyviolation', (e) => P.csp.push(e.violatedDirective + ' ' + e.blockedURI));
  addEventListener('error', (e) => P.errors.push(String(e.message)));
  addEventListener('unhandledrejection', (e) => P.errors.push('unhandled rejection: ' + String(e.reason && (e.reason.stack || e.reason))));
  P.holdMutations = 0;
  let bootDelivered = false;
  new MutationObserver((recs) => {
    const inHold = recs.filter((r) => { const t = r.target.nodeType === 1 ? r.target : r.target.parentElement; return t && (t.id === 'hold' || (t.closest && t.closest('#hold'))); });
    if (!inHold.length) return;
    if (!bootDelivered) { bootDelivered = true; return; }   // boot's own paint arrives in the first delivery
    P.holdMutations += inHold.length;
  }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  const d = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
  Object.defineProperty(Element.prototype, 'innerHTML', {
    configurable: true,
    get() { return d.get.call(this); },
    set(v) {
      if (this.id === 'up' || this.id === 'hold') {
        const st = new Error().stack || '';
        P.writes.push({ id: this.id, who: /boot\\.js/.test(st) ? 'boot' : /newtab\\.js/.test(st) ? 'newtab' : 'other',
          t: Math.round(performance.now()), cta: /Add your first stock/i.test(String(v)),
          head: String(v).replace(/<[^>]+>/g, ' ').replace(/\\s+/g, ' ').trim().slice(0, 70) });
      }
      d.set.call(this, v);
    },
  });
})();`;

async function openPage(b, { width = 1440, height = 900, mobile = false } = {}) {
  const { targetId } = await b.cdp.send('Target.createTarget', { url: 'about:blank' });
  const pg = await attach(b.cdp, targetId);
  const sid = pg.sessionId;
  await b.cdp.send('Page.enable', {}, sid);
  await b.cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile }, sid);
  await b.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT }, sid);
  const nav = async () => {
    const loaded = new Promise((r) => { const off = b.cdp.on((m) => { if (m.sessionId === sid && m.method === 'Page.loadEventFired') { off(); r(); } }); });
    await b.cdp.send('Page.navigate', { url: `chrome-extension://${b.extId}/newtab.html` }, sid);
    await loaded;
    await new Promise((r) => setTimeout(r, 2500));   // hydration, storage events, any late paint
  };
  const metrics = () => b.cdp.eval(sid, `(() => {
    const P = window.__pia || {};
    const de = document.documentElement;
    return {
      boot: window.__catalystBoot, cls: +(P.cls || 0).toFixed(4), shifts: P.shifts, csp: P.csp, errors: P.errors, writes: P.writes, holdMutations: P.holdMutations,
      cards: [...document.querySelectorAll('#hold .cell[data-s]')].map((c) => ({ s: c.dataset.s, px: c.querySelector('.cpx')?.textContent, state: c.className })),
      upText: (document.getElementById('up')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 300),
      upd: document.getElementById('upd')?.textContent,
      overflow: de.scrollWidth > de.clientWidth,
      cols: getComputedStyle(document.querySelector('main')).gridTemplateColumns.split(' ').length,
      fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime,
    };
  })()`);
  return { sid, log: pg.log, nav, metrics, close: () => b.cdp.send('Target.closeTarget', { targetId }) };
}

const b = await launch();
try {
  section(`install (${b.version}, extension ${b.extId})`);
  const sw = await attach(b.cdp, b.swTargetId, { network: true });
  const S = (expr) => b.cdp.eval(sw.sessionId, expr);

  // The first tab a new user sees opens while the install refresh is still in
  // flight — open it immediately, exactly as they would.
  const first = await openPage(b);
  await first.nav();
  const m1 = await first.metrics();

  const t0 = Date.now();
  const settled = await until(async () => {
    const s = await S('chrome.storage.local.get(null)');
    const syms = s.symbols || [];
    return syms.length > 0 && s.quotes?.fetchedAt > 0 && !s.quotes.fetchingSince
      && s.catalysts?.fetchedAt > 0 && s.series?.fetchedAt > 0
      && syms.every((x) => s.meta?.[x] && 'logo' in s.meta[x])
      && syms.every((x) => x in (s.insiders?.seen || {}));
  }, 120000, 400);
  const st = await S('chrome.storage.local.get(null)');
  check(`install refresh completes (${((Date.now() - t0) / 1000).toFixed(1)}s after first tab)`, settled, st.diag);
  check('worker stamped the shipped version', st.diag?.build === manifest.version, `${st.diag?.build} vs ${manifest.version}`);
  check('new users are seeded with starter tickers', (st.symbols || []).length === 3, st.symbols);
  const alarms = await S('chrome.alarms.getAll().then((a) => a.map((x) => x.name).sort())');
  check('all refresh alarms are registered', JSON.stringify(alarms) === JSON.stringify(['refresh-catalysts', 'refresh-quotes', 'refresh-series']), alarms);
  check('no uncaught exceptions in the worker', sw.log.exceptions.length === 0, sw.log.exceptions);
  const swErrors = sw.log.console.filter((c) => c.type === 'error').concat(sw.log.entries.filter((e) => e.level === 'error'));
  check('no errors logged by the worker', swErrors.length === 0, swErrors.slice(0, 5));

  const reqs = [...sw.log.requests.values()];
  const wire = reqs.find((r) => r.url.includes('api.nasdaq.com') && r.headers)?.headers || {};
  const ua = wire['User-Agent'] || wire['user-agent'] || '';
  const brands = wire['sec-ch-ua'] || '';
  check(`the test browser presents like a real user's Chrome (UA: ${ua.slice(0, 60)}…)`, ua && !/Headless/i.test(ua) && !/Headless/i.test(brands), { ua, brands });
  const nasdaq = reqs.filter((r) => r.url.includes('api.nasdaq.com'));
  check(`install cost is bounded (${reqs.length} requests, ${nasdaq.length} to Nasdaq)`, reqs.length > 0 && reqs.length < 120, reqs.length);
  check('no request failed at the network layer', sw.log.failures.filter((f) => !f.canceled).length === 0, sw.log.failures.slice(0, 5));
  check('no HTTP2 stream resets from Nasdaq', !sw.log.failures.some((f) => /HTTP2/.test(f.error)), sw.log.failures.map((f) => f.error));
  // A request can legitimately still be in flight at the moment we snapshot
  // (the page's own wake refresh). Wait for the network to go quiet first, so
  // "no status" means a request that genuinely never answered.
  await until(() => [...sw.log.requests.values()].every((r) => r.status != null || r.t1 != null
    || sw.log.failures.some((f) => f.url === r.url)), 15000, 200);
  const unanswered = nasdaq.filter((r) => r.status == null);
  if (unanswered.length) console.log('        unanswered:', JSON.stringify(unanswered.map((r) => ({ url: r.url, failure: sw.log.failures.filter((f) => f.url === r.url) }))));
  const non200 = nasdaq.filter((r) => r.status != null && r.status !== 200);
  check('no Nasdaq request was left hanging', unanswered.length === 0, unanswered.map((r) => r.url));
  check('every Nasdaq response is HTTP 200', non200.length === 0, non200.slice(0, 5).map((r) => [r.status, r.url]));
  check('Chrome really is speaking HTTP/2 to Nasdaq (the condition that caused the block)', nasdaq.length > 0 && nasdaq.filter((r) => r.status != null).every((r) => r.protocol === 'h2'), [...new Set(nasdaq.map((r) => r.protocol))]);
  for (const s of st.symbols) check(`${s}: priced`, st.quotes.data[s]?.price > 0, st.quotes.data[s]);
  for (const s of st.symbols) check(`${s}: earnings checked`, Array.isArray(st.catalysts.data[s]), st.catalysts.data[s]);
  for (const s of st.symbols) check(`${s}: sparkline stored`, Array.isArray(st.series.data[s]) && st.series.data[s].length > 1, st.series.data[s]);
  for (const s of st.symbols) check(`${s}: logo attempted`, 'logo' in (st.meta[s] || {}), st.meta[s]);

  section('the very first tab after install');
  check('boot script ran', typeof m1.boot === 'number', m1.boot);
  check('no CSP violations', m1.csp.length === 0, m1.csp);
  check('no page errors', m1.errors.length === 0, m1.errors);
  check('no page exceptions', first.log.exceptions.length === 0, first.log.exceptions);
  console.log('        first-tab paints:', JSON.stringify(m1.writes));
  const bootFirst = m1.writes.find((w) => w.who === 'boot' && w.id === 'up');
  check('no paint ever tells a seeded user to "add your first stock"',
    m1.writes.every((w) => !w.cta), m1.writes.filter((w) => w.cta));
  check(`first-tab layout shift is negligible (CLS ${m1.cls})`, m1.cls < 0.1, m1.shifts);

  section('a normal new tab (warm cache)');
  await first.close();
  const warm = await openPage(b);
  await warm.nav();
  const m2 = await warm.metrics();
  check(`paints from cache in under 50ms (${m2.boot?.toFixed(1)}ms)`, m2.boot < 50, m2.boot);
  check(`zero layout shift (CLS ${m2.cls})`, m2.cls === 0, m2.shifts);
  console.log('        warm-tab paints :', JSON.stringify(m2.writes), ' shifts:', JSON.stringify(m2.shifts));
  // On a warm tab boot MUST paint from the mirror, so this proves the paint
  // hook is live — without it, "no repaints" below would pass vacuously.
  check('paint instrumentation is actually recording', m2.writes.some((w) => w.who === 'boot' && w.id === 'up') && m2.writes.some((w) => w.who === 'boot' && w.id === 'hold'), m2.writes);
  const rewrites = m2.writes.filter((w) => w.who !== 'boot');
  check('hydration does not repaint what boot already painted', rewrites.length === 0, rewrites);
  check('and does not touch a single card node', m2.holdMutations === 0, m2.holdMutations);
  check('no CSP violations', m2.csp.length === 0, m2.csp);
  check('no page errors', m2.errors.length === 0 && warm.log.exceptions.length === 0, [m2.errors, warm.log.exceptions]);
  check('two columns on a desktop window', m2.cols === 2, m2.cols);
  check('no horizontal scrolling on desktop', !m2.overflow);
  check('every tracked ticker has a card', m2.cards.length === st.symbols.length, m2.cards);

  section('what is on screen matches the data, and the data matches the market');
  const cnbc = {};
  const url = 'https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols='
    + encodeURIComponent(st.symbols.join('|')) + '&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json';
  for (const q of (await (await fetch(url, { headers: { 'User-Agent': UA } })).json())?.FormattedQuoteResult?.FormattedQuote || []) cnbc[q.symbol] = q;
  const live = await S('chrome.storage.local.get("quotes").then((s) => s.quotes.data)');
  for (const c of m2.cards) {
    const stored = live[c.s]?.price;
    check(`${c.s}: card shows the stored price (${c.px})`, stored != null && c.px === stored.toFixed(2), { card: c.px, stored });
    const ref = Number(String(cnbc[c.s]?.last || '').replace(/,/g, ''));
    if (Number.isFinite(ref) && ref > 0) {
      // Weekend/after-close: must agree to the cent. Intraday: sources tick at different moments.
      const closed = !/open/i.test(String(cnbc[c.s]?.curmktstatus || ''));
      const tol = closed ? 0.011 : Math.max(0.02, ref * 0.004);
      check(`${c.s}: price agrees with CNBC consolidated (${c.px} vs ${ref}${closed ? ', market closed' : ', intraday'})`, Math.abs(Number(c.px) - ref) <= tol, { card: c.px, cnbc: ref });
    }
  }

  section('background updates never break the cards');
  {
    const sid = warm.sid;
    const E = (e) => b.cdp.eval(sid, e);
    const bumpSeries = () => S(`chrome.storage.local.get('series').then((x) => { x.series.data.MSFT = x.series.data.MSFT.map((v, i) => +(v + (i % 2 ? 0.01 : -0.01)).toFixed(2)); return chrome.storage.local.set({ series: x.series }); })`);
    const settleUI = () => new Promise((r) => setTimeout(r, 700));

    // A throwaway ticker to remove, so the watchlist is left as it was.
    await S(`chrome.storage.local.get('symbols').then((x) => chrome.storage.local.set({ symbols: [...x.symbols, 'KO'] }))`);
    await E(`chrome.runtime.sendMessage({ type: 'refresh', reason: 'add', symbol: 'KO' })`).catch(() => {});
    await until(() => E(`/\\d/.test(document.querySelector('#hold [data-s="KO"] .cpx')?.textContent || '')`), 20000, 150);
    await settleUI();
    const p = await E(`(() => { const r = document.querySelector('#hold [data-rm="KO"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await b.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y }, sid);
    await b.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 }, sid);
    await bumpSeries();                                   // lands while the button is held down
    await settleUI();
    await b.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 }, sid);
    check('a click on remove still works when a background update lands mid-click',
      await until(async () => !(await S('chrome.storage.local.get("symbols")')).symbols.includes('KO'), 4000, 100));

    await E(`document.querySelector('#hold [data-rm="NVDA"]').focus()`);
    await bumpSeries(); await settleUI();
    check('keyboard focus on a card survives a background update',
      await E(`document.activeElement && document.activeElement.getAttribute('data-rm') === 'NVDA'`));

    // Faithfulness: after many in-place updates, the grid must be exactly what a
    // clean render of the same data produces.
    await S(`chrome.storage.local.get('meta').then((x) => { x.meta.NVDA.name = 'NVIDIA Corporation Common Stock'; if (x.meta.AAPL) x.meta.AAPL.logo = null; return chrome.storage.local.set({ meta: x.meta }); })`);
    await settleUI();
    await S(`chrome.storage.local.get('settings').then((x) => chrome.storage.local.set({ settings: { ...x.settings, sort: { by: 'name', dir: 'asc' } } }))`);
    await settleUI();
    await S(`chrome.storage.local.get('quotes').then((x) => { x.quotes.data.MSFT.price = +(x.quotes.data.MSFT.price + 0.37).toFixed(2); return chrome.storage.local.set({ quotes: x.quotes }); })`);
    await settleUI();
    await bumpSeries(); await settleUI();
    // Price and sparkline in ONE write: that takes the in-place morph path (not
    // the quote-only text patch), so the morph's own text updates are exercised.
    await S(`chrome.storage.local.get(['quotes','series']).then((x) => { x.quotes.data.NVDA.price = +(x.quotes.data.NVDA.price - 1.23).toFixed(2); x.quotes.data.NVDA.changePct = -2.5; x.series.data.NVDA = x.series.data.NVDA.map((v) => +(v - 1).toFixed(2)); return chrome.storage.local.set({ quotes: x.quotes, series: x.series }); })`);
    await settleUI();
    const CANON = `(() => { const canon = (n) => { if (n.nodeType === 3) return JSON.stringify(n.nodeValue); if (n.nodeType !== 1) return '';
      const attrs = [...n.attributes].filter((a) => a.name !== 'data-k').map((a) => a.name === 'class' ? 'class=' + a.value.split(/\\s+/).filter((c) => c && c !== 'fl').sort().join(' ') : a.name + '=' + a.value).sort();
      return '<' + n.nodeName + (attrs.length ? ' ' + attrs.join(' ') : '') + '>' + [...n.childNodes].map(canon).join('') + '</' + n.nodeName + '>'; };
      return canon(document.getElementById('hold')); })()`;
    const lived = await E(CANON);
    const fresh = await openPage(b);
    await fresh.nav();
    const clean = await b.cdp.eval(fresh.sid, CANON);
    let i = 0; while (i < lived.length && lived[i] === clean[i]) i++;
    check('after many in-place updates the cards are identical to a clean render', lived === clean,
      lived === clean ? '' : `first difference at ${i}\n   updated: …${lived.slice(Math.max(0, i - 80), i + 80)}\n   clean  : …${clean.slice(Math.max(0, i - 80), i + 80)}`);
    await fresh.close();
    await S(`chrome.storage.local.get('settings').then((x) => chrome.storage.local.set({ settings: { ...x.settings, sort: { by: 'change', dir: 'desc' } } }))`);
    await settleUI();
  }

  section('an after-hours payload never becomes the day price (intercepted, real worker)');
  {
    // Nasdaq's own marketStatus decides how a payload is read, so a genuine
    // after-hours payload can be replayed at any hour. These are SHOP's real
    // numbers from 15 Sep 2026: the session closed at 129.86 (-4.03, -3.01%
    // from 133.89) and it then traded at 130.00 (+0.14, +0.11%) after hours.
    await S(`chrome.storage.local.set({ symbols: ['SHOP'],
      meta: { SHOP: { name: 'Shopify Inc.', exchange: 'NASDAQ', cls: 'stocks', logo: null } },
      quotes: { fetchedAt: Date.now() - 40 * 60000, fetchingSince: 0, stale: false, reason: null, unknown: {},
                data: { SHOP: { price: 129.86, changePct: -3.01, prevClose: 133.89 } } } })`);
    const AFTER_HOURS = JSON.stringify({ data: { symbol: 'SHOP', companyName: 'Shopify Inc.', exchange: 'NASDAQ-GS', marketStatus: 'After Hours',
      primaryData: { lastSalePrice: '$130.00', netChange: '+0.14', percentageChange: '+0.11%', deltaIndicator: 'up', isRealTime: true },
      secondaryData: null } });
    const EXTENDED = JSON.stringify({ data: { infoTable: { rows: [{ consolidated: '$130.36 -3.53 (-2.64%)' }] } } });
    const off = b.cdp.on(async (m) => {
      if (m.sessionId !== sw.sessionId || m.method !== 'Fetch.requestPaused') return;
      const { requestId, request } = m.params;
      const body = /\/quote\/SHOP\/info/.test(request.url) ? AFTER_HOURS
        : /extended-trading/.test(request.url) ? EXTENDED : null;
      try {
        if (body) await b.cdp.send('Fetch.fulfillRequest', { requestId, responseCode: 200, body: Buffer.from(body).toString('base64'),
          responseHeaders: [{ name: 'Content-Type', value: 'application/json' }] }, sw.sessionId);
        else await b.cdp.send('Fetch.continueRequest', { requestId }, sw.sessionId);
      } catch { /* the worker may have moved on */ }
    });
    await b.cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*api.nasdaq.com*' }] }, sw.sessionId);
    // Exactly what clicking the footer does.
    await b.cdp.eval(warm.sid, `new Promise((r) => chrome.runtime.sendMessage({ type: 'refresh', reason: 'user' }, () => r(true)))`, 60000).catch(() => {});
    await until(async () => (await S('chrome.storage.local.get("quotes")')).quotes.data.SHOP?.ext, 20000, 200);
    const q = (await S('chrome.storage.local.get("quotes")')).quotes.data.SHOP;
    await b.cdp.send('Fetch.disable', {}, sw.sessionId);
    off();
    check(`the card keeps the session close (${q.price}), not the after-hours trade`, q.price === 129.86, q);
    check(`the card keeps the day's move (${q.changePct}%), not the after-hours move`, q.changePct === -3.01, q);
    check('the previous close is not overwritten', q.prevClose === 133.89, q);
    // Which extended print supplies the line depends on the session (the quote
    // payload itself, or the dedicated extended-trading call). What must always
    // hold is that its percentage is measured against the day's close.
    const vsClose = q.ext ? Math.round(((q.ext.price - q.price) / q.price) * 1e4) / 100 : null;
    check(`the after-hours line is measured against the close (${q.ext?.price} / ${q.ext?.changePct}% vs ${vsClose}% implied)`,
      q.ext && q.ext.price > 129.86 && Math.abs(q.ext.changePct - vsClose) <= 0.02, { ext: q.ext, close: q.price, vsClose });
  }

  section('an insider row opens its SEC filing');
  {
    const sid = warm.sid;
    const before = await S('chrome.storage.local.get("insiders")');
    // Insider rows only show for tracked stocks, and earlier sections change
    // the watchlist — so attach the purchase to whatever is tracked right now.
    const sym = (await S('chrome.storage.local.get("symbols")')).symbols[0];
    await S(`chrome.storage.local.get('insiders').then((x) => chrome.storage.local.set({ insiders: { ...x.insiders,
      data: { ...(x.insiders.data || {}), ${JSON.stringify(sym)}: [{ who: 'Rusckowski Stephen H', role: 'Director', date: '9/29/2026', days: 4,
        shares: 25000, price: 139.35, value: 3483750, stakePct: null, isNew: false }] } } }))`);
    const shown = await until(() => b.cdp.eval(sid, `Boolean(document.querySelector('#up .row.buy .rlink'))`), 6000, 100);
    check(`the insider row renders with its link (${sym})`, shown, await b.cdp.eval(sid, `document.getElementById('up')?.innerHTML.slice(0, 300)`));
    if (!shown) throw new Error('insider row never rendered; the click checks below would be meaningless');
    // A new tab reports its URL either on creation or once it starts loading.
    const nextSecTab = () => new Promise((resolve) => {
      const timer = setTimeout(() => { off(); resolve(null); }, 10000);
      const off = b.cdp.on((m) => {
        const t = m.params?.targetInfo;
        if ((m.method === 'Target.targetCreated' || m.method === 'Target.targetInfoChanged') && t?.type === 'page' && /^https:\/\/www\.sec\.gov\//.test(t.url)) {
          clearTimeout(timer); off(); resolve(t);
        }
      });
    });
    const expected = `https://www.sec.gov/edgar/search/#/q=%22Rusckowski%22%20%22${encodeURIComponent(sym)}%22&dateRange=custom&startdt=2026-09-29&enddt=2026-10-09&forms=4`;

    // Mouse: click on the row's TEXT. The overlay must be what receives it.
    const p = await b.cdp.eval(sid, `(() => { const e = document.querySelector('#up .row.buy .evt'); e.scrollIntoView({ block: 'center' });
      const r = e.getBoundingClientRect(); return { x: r.left + 24, y: r.top + r.height / 2 }; })()`);
    const viaMouse = nextSecTab();
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await b.cdp.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 }, sid);
    }
    const t1 = await viaMouse;
    check('clicking the row text opens a new tab', Boolean(t1), t1);
    check('at the SEC search for that person\'s Form 4', t1?.url === expected, t1?.url);
    if (t1) await b.cdp.send('Target.closeTarget', { targetId: t1.targetId }).catch(() => {});
    check('the new-tab page itself stays put', await b.cdp.eval(sid, `location.protocol === 'chrome-extension:'`));

    // Keyboard: Tab to the row's link and press Enter.
    await b.cdp.eval(sid, `document.querySelector('#up .row.buy .rlink').focus()`);
    check('the link is reachable by keyboard', await b.cdp.eval(sid, `document.activeElement && document.activeElement.classList.contains('rlink')`));
    const viaKey = nextSecTab();
    await b.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, sid);
    await b.cdp.send('Input.dispatchKeyEvent', { type: 'char', key: 'Enter', text: '\r' }, sid);
    await b.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, sid);
    const t2 = await viaKey;
    check('Enter on the focused row opens the same filing', t2?.url === expected, t2?.url);
    if (t2) await b.cdp.send('Target.closeTarget', { targetId: t2.targetId }).catch(() => {});

    await S(`chrome.storage.local.set({ insiders: ${JSON.stringify(before.insiders)} })`);
    await until(() => b.cdp.eval(sid, `!document.querySelector('#up .row.buy .rlink[href*="Rusckowski"]')`), 6000, 100);
  }

  section('add and remove a ticker through the real UI');
  {
    const sid = warm.sid;
    const center = (sel) => b.cdp.eval(sid, `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null;
      e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    const click = async (sel) => {
      const p = await center(sel);
      if (!p) throw new Error(`nothing to click: ${sel}`);
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await b.cdp.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 }, sid);
      }
    };
    const press = async (key, vk) => {   // CDP: `code` is the DOM code string, the number is the virtual key
      await b.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: key, windowsVirtualKeyCode: vk }, sid);
      await b.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: vk }, sid);
    };
    const reqsBefore = sw.log.requests.size;

    await click('#hold .cell.add');
    check('the add button opens search with the input focused',
      await until(() => b.cdp.eval(sid, `document.activeElement && document.activeElement.id === 'si'`), 3000));
    await b.cdp.send('Input.insertText', { text: 'coinbase' }, sid);
    const found = await until(() => b.cdp.eval(sid, `[...document.querySelectorAll('#sres [role=option]')].some((li) => li.querySelector('.rsym')?.textContent === 'COIN')`), 10000, 150);
    check('searching a company name finds its ticker (live Nasdaq search)', found,
      await b.cdp.eval(sid, `document.getElementById('sres')?.innerText || document.getElementById('smsg')?.innerText`));
    const idx = await b.cdp.eval(sid, `[...document.querySelectorAll('#sres [role=option]')].findIndex((li) => li.querySelector('.rsym')?.textContent === 'COIN')`);
    check('COIN is among the results', idx >= 0, idx);
    for (let i = 0; i < idx; i++) await press('ArrowDown', 40);
    await press('Enter', 13);

    const added = await until(async () => {
      const q = await S('chrome.storage.local.get(["symbols","quotes"])');
      return q.symbols.includes('COIN') && q.quotes.data.COIN?.price > 0;
    }, 20000, 250);
    check('Enter adds it and it gets priced', added, await S('chrome.storage.local.get("symbols")'));
    const coinPx = (await S('chrome.storage.local.get("quotes")')).quotes.data.COIN?.price;
    const shown = await until(() => b.cdp.eval(sid, `document.querySelector('#hold [data-s="COIN"] .cpx')?.textContent === ${JSON.stringify(coinPx?.toFixed(2))}`), 5000, 150);
    check(`the new card shows the stored price (${coinPx?.toFixed(2)})`, shown, await b.cdp.eval(sid, `document.querySelector('#hold [data-s="COIN"]')?.outerHTML?.slice(0, 200)`));
    const meta = (await S('chrome.storage.local.get("meta")')).meta.COIN;
    check('the company name is saved, not the ticker', meta?.name && meta.name !== 'COIN' && /coinbase/i.test(meta.name), meta);
    await until(() => [...sw.log.requests.values()].slice(reqsBefore).every((r) => r.status != null || sw.log.failures.some((f) => f.url === r.url)), 10000, 200);
    const addReqs = [...sw.log.requests.values()].slice(reqsBefore);
    check(`the add costs the worker at most 10 requests (${addReqs.length})`, addReqs.length <= 10, addReqs.map((r) => r.url.replace(/^https:\/\/[^/]+/, '')));

    await click('#hold [data-s="COIN"] [data-rm="COIN"]');
    const removed = await until(async () => {
      const q = await S('chrome.storage.local.get(null)');
      return !q.symbols.includes('COIN');
    }, 5000, 150);
    check('the remove button removes it', removed);
    const after = await S('chrome.storage.local.get(null)');
    check('its card is gone', !(await b.cdp.eval(sid, `Boolean(document.querySelector('#hold [data-s="COIN"]'))`)));
    check('nothing is left behind in storage', !('COIN' in after.meta) && !('COIN' in after.quotes.data) && !('COIN' in (after.catalysts.data || {})),
      { meta: 'COIN' in after.meta, quote: 'COIN' in after.quotes.data, catalysts: 'COIN' in (after.catalysts.data || {}) });
    const m4 = await warm.metrics();
    check('no page errors during add and remove', m4.errors.length === 0 && warm.log.exceptions.length === 0, [m4.errors, warm.log.exceptions]);
  }

  section('phone-width layout');
  await warm.close();
  const phone = await openPage(b, { width: 375, height: 812, mobile: true });
  await phone.nav();
  const m3 = await phone.metrics();
  check('single column on a phone-width window', m3.cols === 1, m3.cols);
  check('no horizontal scrolling at 375px', !m3.overflow);
  check('no page errors at phone width', m3.errors.length === 0, m3.errors);
  await phone.close();

  section('settings on a short laptop screen (1366x640)');
  {
    const short = await openPage(b, { width: 1366, height: 640 });
    await short.nav();
    await b.cdp.eval(short.sid, `document.getElementById('gear').click()`);
    await new Promise((r) => setTimeout(r, 700));
    const before = await b.cdp.eval(short.sid, `(() => { const sp = document.querySelector('.ov.on .sp') || document.querySelector('[role=dialog]');
      const a = document.querySelector('.about'); return { scrollable: sp.scrollHeight > sp.clientHeight, fits: sp.getBoundingClientRect().bottom <= innerHeight,
      aboutVisible: a && a.getBoundingClientRect().bottom <= innerHeight }; })()`);
    check('the panel stays within the window', before.fits, before);
    const after = await b.cdp.eval(short.sid, `(() => { const sp = document.querySelector('.ov.on .sp') || document.querySelector('[role=dialog]'); sp.scrollTop = sp.scrollHeight;
      return new Promise((r) => requestAnimationFrame(() => { const a = document.querySelector('.about').getBoundingClientRect(); const t = document.getElementById('thm').getBoundingClientRect();
      r({ about: a.top >= 0 && a.bottom <= innerHeight, theme: t.top >= 0 && t.bottom <= innerHeight }); })); })()`);
    check('its last controls and the data note can be scrolled into view', after.about && after.theme, { before, after });
    await short.close();
  }
} catch (e) {
  check('chrome test ran to completion', false, e.stack);
} finally {
  await shutdown(b);
}
done('real Chrome');
