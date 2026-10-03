/**
 * The service worker, driven the way Chrome drives it, against a Nasdaq stand-in
 * that counts every request. These assert the COST of ordinary behaviour as well
 * as its correctness: request storms are what got a real browser soft-blocked.
 *
 * Each scenario runs in its own process. Several modules hold state for the life
 * of a worker (the request gate, the sync device id), and a shared process would
 * let one scenario's leftovers decide another's result.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { imp, check, section, done, until, fakeChrome, installClock, etSept, nasdaqStub, sendMessage } from './lib.mjs';

const SELF = fileURLToPath(import.meta.url);
const settle = (ms = 600) => new Promise((r) => setTimeout(r, ms));
const quiet = async (stub, quietMs = 500, maxMs = 20000) => {
  const end = Date.now() + maxMs; let last = -1; let since = Date.now();
  await settle(120);
  while (Date.now() < end) {
    const n = stub.total();
    if (n !== last) { last = n; since = Date.now(); } else if (Date.now() - since >= quietMs) return;
    await new Promise((r) => setTimeout(r, 40));
  }
};

const FULL = (symbols, at, extra = {}) => ({
  schemaVersion: 4, symbols, prefsAt: 0,
  settings: { apiKey: null, showPrices: true, showCatalysts: true, showInsiders: true, showExtended: true, theme: 'auto', sort: { by: 'change', dir: 'desc' } },
  meta: Object.fromEntries(symbols.map((s) => [s, { name: `${s} Inc.`, exchange: 'NASDAQ', cls: 'stocks', logo: null }])),
  quotes: { fetchedAt: at - 60e3, fetchingSince: 0, stale: false, reason: null, unknown: {}, data: Object.fromEntries(symbols.map((s) => [s, { price: 100, changePct: 1.01, prevClose: 99, at: at - 60e3 }])) },
  catalysts: { fetchedAt: at - 3600e3, scannedAt: at - 3600e3, stale: false, data: Object.fromEntries(symbols.map((s) => [s, []])), tried: {} },
  series: { fetchedAt: at - 60e3, stale: false, data: Object.fromEntries(symbols.map((s) => [s, [99, 100, 101]])) },
  results: { fetchedAt: at - 60e3, data: {} },
  insiders: { fetchedAt: at - 60e3, seen: Object.fromEntries(symbols.map((s) => [s, 1])), data: {} },
  ...extra,
});

/** Boot one worker in this process. Globals must exist before the import. */
async function boot({ at, local = {}, sync = {}, stub = nasdaqStub() }) {
  const clock = installClock(at);
  const fc = fakeChrome(local, sync);
  globalThis.chrome = fc.chrome;
  globalThis.fetch = stub.fetchImpl;
  await imp('src/background.js');
  const net = await imp('src/net.js');
  return { ...fc, clock, stub, net, get: (k) => fc.chrome.storage.local.get(k) };
}

const SCENARIOS = {
  async 'fresh install'() {
    const w = await boot({ at: etSept(15, 13) });
    for (const f of w.listeners.installed) f({ reason: 'install' });
    await until(async () => (await w.get('quotes')).quotes?.fetchedAt > 0 && (await w.get('catalysts')).catalysts?.fetchedAt > 0, 20000);
    await quiet(w.stub, 2500);   // long enough for the sync push (2s debounce) and its echo
    const s = await w.get(null);
    check('new users are seeded with three tickers', s.symbols?.length === 3, s.symbols);
    check('all three alarms exist', Object.keys(w.alarms).sort().join() === 'refresh-catalysts,refresh-quotes,refresh-series', Object.keys(w.alarms));
    check('every seeded ticker is priced', s.symbols.every((x) => s.quotes.data[x]?.price > 0), s.quotes.data);
    check(`the install costs one quote per ticker, not a second forced pass (${w.stub.counts.quote})`, w.stub.counts.quote === 3, w.stub.counts);
    check('the extension\'s own sync push is not re-applied', s.diag?.sync?.incoming !== 'applied', s.diag?.sync);
  },

  async 'own sync echo is ignored even when meta changed in between'() {
    const at = etSept(15, 13);
    const w = await boot({ at, local: FULL(['AAPL', 'MSFT'], at) });
    const sync = await imp('src/sync.js');
    await sync.push(await (await imp('src/store.js')).getState());
    // A refresh lands between the push and its echo — the race that used to re-apply the echo.
    await w.chrome.storage.local.set({ meta: { AAPL: { name: 'Apple Inc.', exchange: 'NASDAQ', cls: 'stocks' }, MSFT: { name: 'Microsoft', exchange: 'NASDAQ', cls: 'stocks' } } });
    w.stub.reset();
    await until(async () => (await w.get('diag')).diag?.sync?.incoming, 5000);
    await quiet(w.stub, 800);
    const d = (await w.get('diag')).diag;
    check('the echo is recognised as our own write', d.sync?.incoming === 'own', d.sync);
    check('and triggers no refresh at all', w.stub.total() === 0, w.stub.counts);
    check('local meta was not overwritten by the stale echo', (await w.get('meta')).meta.MSFT.name === 'Microsoft');
  },

  async 'a change from another device fetches only what is new'() {
    const at = etSept(15, 13);
    const w = await boot({ at, local: FULL(['AAPL', 'MSFT', 'NVDA', 'INTC'], at) });
    w.stub.reset();
    await w.chrome.storage.sync.set({ 'catalyst:prefs': { v: 1, symbols: ['AAPL', 'MSFT', 'NVDA', 'INTC', 'COIN'], settings: {}, meta: {}, at: at + 1000, from: 'another-device' } });
    await until(async () => (await w.get('quotes')).quotes.data.COIN, 10000);
    await quiet(w.stub, 800);
    check('the new ticker arrived', (await w.get('symbols')).symbols.includes('COIN'));
    check(`only the new ticker was quoted (${w.stub.counts.quote})`, w.stub.counts.quote === 1, w.stub.urls.filter((u) => u.startsWith('quote')));
    check('no calendar scan for a sync change', !w.stub.counts['calendar-day'], w.stub.counts);
  },

  async 'adding a ticker is cheap'() {
    const at = etSept(15, 13);
    const w = await boot({ at, local: FULL(['AAPL', 'MSFT', 'NVDA'], at) });
    w.stub.reset();
    await w.chrome.storage.local.set({ symbols: ['AAPL', 'MSFT', 'NVDA', 'COIN'] });
    await sendMessage(w.listeners, { type: 'refresh', reason: 'add', symbol: 'COIN' });
    await quiet(w.stub);
    check(`an add costs at most 8 requests (${w.stub.total()})`, w.stub.total() <= 8, w.stub.counts);
    check('an add does not scan the calendar', !w.stub.counts['calendar-day'], w.stub.counts);
    check('the new ticker is priced', (await w.get('quotes')).quotes.data.COIN?.price > 0);
    check('an add does not claim the whole calendar is fresh', (await w.get('catalysts')).catalysts.fetchedAt === at - 3600e3);
  },

  async 'unresolved earnings dates do not become a request loop'() {
    const at = etSept(15, 13);
    const syms = ['AAPL', 'MSFT', 'NVDA', 'INTC', 'KO', 'JPM', 'PFE', 'DIS', 'NKE', 'COST'];
    const earnings = Object.fromEntries(syms.slice(0, 7).map((s) => [s, '10/22/2026 after market close']));
    const local = FULL(syms, at);
    for (const s of syms.slice(7)) delete local.catalysts.data[s];   // three the vendor has no date for
    const w = await boot({ at, local, stub: nasdaqStub({ earnings }) });
    const wake = async () => { w.stub.reset(); await sendMessage(w.listeners, { type: 'wake' }); await quiet(w.stub, 400); return w.stub.counts['earnings-date'] || 0; };

    const first = await wake();
    check(`first new tab looks up only the 3 unresolved tickers, not all 10 (${first})`, first === 3, w.stub.urls);
    const c1 = (await w.get('catalysts')).catalysts;
    check('a partial pass does not restamp the calendar as fresh', c1.fetchedAt === at - 3600e3, c1.fetchedAt);
    check('exactly the unresolved tickers are recorded as tried', Object.keys(c1.tried || {}).sort().join() === 'COST,DIS,NKE', c1.tried);
    let later = 0;
    for (let i = 0; i < 5; i++) { w.clock.advance(61e3); later += await wake(); }
    check(`five more tabs over 5 minutes cost nothing (${later})`, later === 0, w.stub.urls);
    w.clock.advance(61 * 60e3);
    check('an hour later they are tried once more', (await wake()) === 3);
  },

  async 'the daily refresh still happens'() {
    const at = etSept(15, 13);
    const syms = ['AAPL', 'MSFT', 'NVDA', 'INTC'];
    const local = FULL(syms, at);
    delete local.catalysts.data.INTC;   // one perpetually unresolved ticker
    const w = await boot({ at, local, stub: nasdaqStub({ earnings: { AAPL: '10/29/2026 after market close' } }) });
    // A full day of hourly tabs, while partial passes keep happening. Whichever
    // tab first finds the calendar 23h stale must run the full pass — the
    // invariant is that it happens, not which tab it lands on.
    const perWake = [];
    for (let h = 0; h < 26; h++) {
      w.stub.reset();
      await sendMessage(w.listeners, { type: 'wake' });
      await quiet(w.stub, 350);
      perWake.push({ h, lookups: w.stub.counts['earnings-date'] || 0, fetchedAt: (await w.get('catalysts')).catalysts.fetchedAt });
      w.clock.advance(61 * 60e3);
    }
    const full = perWake.filter((x) => x.lookups === syms.length);
    check(`the full calendar refresh ran within the day despite constant partial passes (hour ${full[0]?.h})`, full.length >= 1 && full[0].h <= 23, perWake);
    check('only the full pass restamped freshness', perWake.filter((x) => x.fetchedAt !== at - 3600e3).every((x) => x.h >= full[0]?.h), perWake);
    check('outside that, an unresolved ticker costs at most one lookup an hour', perWake.filter((x) => x.lookups !== syms.length).every((x) => x.lookups <= 1), perWake);
  },

  async 'a failed calendar pass waits before retrying'() {
    const at = etSept(15, 13);
    const local = FULL(['AAPL', 'MSFT'], at);
    delete local.catalysts.data.MSFT;
    const w = await boot({ at, local, stub: nasdaqStub({ earnings: { MSFT: 'error' } }) });
    await sendMessage(w.listeners, { type: 'wake' }); await quiet(w.stub, 400);
    w.stub.reset();
    for (let i = 0; i < 3; i++) { w.clock.advance(61e3); await sendMessage(w.listeners, { type: 'wake' }); await quiet(w.stub, 300); }
    check(`an outage does not turn every tab into another attempt (${w.stub.counts['earnings-date'] || 0})`, !w.stub.counts['earnings-date'], w.stub.urls);
  },

  async 'only a deliberate refresh clears the backoff'() {
    const at = etSept(15, 13);
    const w = await boot({ at, local: FULL(['AAPL'], at) });
    const trip = async () => { w.net.resetBreakers(); globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); }; for (let i = 0; i < 6; i++) { try { await w.net.gatedFetch('https://api.nasdaq.com/x'); } catch {} } globalThis.fetch = w.stub.fetchImpl; };
    await trip();
    check('the breaker is open', w.net.isBlocked('api.nasdaq.com'));
    await w.chrome.storage.local.set({ symbols: ['AAPL', 'COIN'] });
    await sendMessage(w.listeners, { type: 'refresh', reason: 'add', symbol: 'COIN' }); await settle(300);
    check('adding a ticker leaves it open', w.net.isBlocked('api.nasdaq.com'));
    await sendMessage(w.listeners, { type: 'refresh', reason: 'user' }); await settle(300);
    check('clicking refresh clears it', !w.net.isBlocked('api.nasdaq.com'));
  },

  async 'ETF sparklines use the ETF asset class'() {
    const at = etSept(15, 13);
    const local = FULL(['AAPL', 'SPY'], at);
    local.meta.SPY.cls = 'etf';
    local.series = { fetchedAt: 0, stale: false, data: {} };
    const w = await boot({ at, local, stub: nasdaqStub({ etfs: ['SPY'] }) });
    for (const f of w.listeners.alarm) f({ name: 'refresh-series' });
    await until(async () => (await w.get('series')).series.data.SPY, 8000);
    check('SPY has a sparkline', (await w.get('series')).series.data.SPY?.length > 1, (await w.get('series')).series);
    check('its chart was requested as an ETF, once', w.stub.counts['chart:etf'] === 1 && !w.stub.urls.some((u) => /chart\?assetclass=stocks/.test(u) && u.includes('SPY')), w.stub.urls);
  },
};

// Market-session cadence: one worker per clock position. During pre-market and
// after-hours the quote request also carries the extended trade, so the
// dedicated extended-hours call is not made at all.
const CADENCE = [
  ['05:00 ET pre-market', etSept(15, 5), 'pre', { quote: 2, extended: 0 }],
  ['13:00 ET regular', etSept(15, 13), 'open', { quote: 2, extended: 0 }],
  ['17:30 ET after-hours', etSept(15, 17, 30), 'after', { quote: 2, extended: 0 }],
  ['21:00 ET closed, close already captured', etSept(15, 21), 'closed', { quote: 0, extended: 0 }],
  ['Saturday noon, close already captured', etSept(19, 12), 'closed', { quote: 0, extended: 0 }],
];
for (const [label, at, session, want] of CADENCE) {
  SCENARIOS[`cadence: ${label}`] = async () => {
    const local = FULL(['AAPL', 'MSFT'], at);
    local.quotes.fetchedAt = at - 20 * 60e3;
    for (const r of Object.values(local.quotes.data)) r.at = at - 20 * 60e3;
    const w = await boot({ at, local, stub: nasdaqStub({ session }) });
    for (const f of w.listeners.alarm) f({ name: 'refresh-quotes' });
    await quiet(w.stub, 500);
    const got = { quote: w.stub.counts.quote || 0, extended: w.stub.counts.extended || 0 };
    check(`quote alarm at ${label}: quotes=${got.quote} extended=${got.extended}`, got.quote === want.quote && got.extended === want.extended, got);
  };
}
SCENARIOS['cadence: extended hours switched off'] = async () => {
  const at = etSept(15, 17, 30);
  const local = FULL(['AAPL'], at);
  local.settings.showExtended = false;
  local.quotes.fetchedAt = at - 20 * 60e3;
  local.quotes.data.AAPL.at = at - 20 * 60e3;          // read after the close settled
  const w = await boot({ at, local, stub: nasdaqStub({ session: 'after' }) });
  for (const f of w.listeners.alarm) f({ name: 'refresh-quotes' });
  await quiet(w.stub, 500);
  check('no traffic after hours when extended hours are off and the close is captured', w.stub.total() === 0, w.stub.counts);
};

/* ---- the official close (the gap 1.6.1 left open) ---------------------- */
SCENARIOS['after the bell, the official close replaces the last intraday price'] = async () => {
  const at = etSept(15, 16, 35);
  const local = FULL(['AAPL'], at);
  // last regular-session fetch at 15:52: an intraday price, not the close
  Object.assign(local.quotes.data.AAPL, { price: 100.37, changePct: 1.38, prevClose: 99, at: etSept(15, 15, 52) });
  local.quotes.fetchedAt = etSept(15, 15, 52);
  const w = await boot({ at, local, stub: nasdaqStub({ session: 'after' }) });
  for (const f of w.listeners.alarm) f({ name: 'refresh-quotes' });
  await quiet(w.stub, 500);
  const q = (await w.get('quotes')).quotes.data.AAPL;
  check(`the card now holds the official close (${q.price}), not the 15:52 price`, q.price === 100, q);
  check(`and the day move against the previous close (${q.changePct}%)`, q.changePct === 1.01, q);
  check('the previous close is untouched', q.prevClose === 99, q);
  check(`the after-hours line is measured against that close (${q.ext?.price} / ${q.ext?.changePct}%)`, q.ext?.price === 100.5 && q.ext?.changePct === 0.5, q.ext);
};

SCENARIOS['extended hours off: the close is still captured, once'] = async () => {
  const at = etSept(15, 16, 35);
  const local = FULL(['AAPL'], at);
  local.settings.showExtended = false;
  Object.assign(local.quotes.data.AAPL, { price: 100.37, changePct: 1.38, prevClose: 99, at: etSept(15, 15, 52) });
  local.quotes.fetchedAt = etSept(15, 15, 52);
  const w = await boot({ at, local, stub: nasdaqStub({ session: 'after' }) });
  for (const f of w.listeners.alarm) f({ name: 'refresh-quotes' });
  await quiet(w.stub, 500);
  const q = (await w.get('quotes')).quotes.data.AAPL;
  check(`the close is captured even with the extended line off (${q.price})`, q.price === 100, q);
  check('and no extended line is written', !q.ext, q.ext);
  w.stub.reset(); w.clock.advance(16 * 60e3);
  for (const f of w.listeners.alarm) f({ name: 'refresh-quotes' });
  await quiet(w.stub, 500);
  check('once captured, later alarms make no requests', w.stub.total() === 0, w.stub.counts);
};

SCENARIOS['overnight, only cards missing the close are fetched'] = async () => {
  const at = etSept(15, 22);
  const local = FULL(['AAPL', 'MSFT', 'NVDA'], at);
  local.quotes.data.AAPL.at = etSept(15, 18);          // captured after the settle point
  local.quotes.data.MSFT.at = etSept(15, 15, 52);      // browser closed before the bell
  delete local.quotes.data.NVDA.at;                    // a cache written by 1.6.1
  const w = await boot({ at, local, stub: nasdaqStub({ session: 'closed' }) });
  for (const f of w.listeners.alarm) f({ name: 'refresh-quotes' });
  await quiet(w.stub, 500);
  const asked = w.stub.urls.filter((u) => u.startsWith('quote')).map((u) => /quote\/([A-Z.]+)\//.exec(u)[1]).sort();
  check(`exactly the two cards without a settled close are fetched (${asked.join(', ')})`, asked.join() === 'MSFT,NVDA', w.stub.urls);
  w.stub.reset(); w.clock.advance(16 * 60e3);
  for (const f of w.listeners.alarm) f({ name: 'refresh-quotes' });
  await quiet(w.stub, 500);
  check('after that the night is quiet', w.stub.total() === 0, w.stub.counts);
};

SCENARIOS['an empty change field right after the bell means the price is the close'] = async () => {
  const at = etSept(15, 16, 5);
  const local = FULL(['AAPL'], at);
  Object.assign(local.quotes.data.AAPL, { price: 100.37, changePct: 1.38, at: etSept(15, 15, 52) });
  local.quotes.fetchedAt = etSept(15, 15, 52);
  const w = await boot({ at, local, stub: nasdaqStub({ session: 'after', emptyChange: ['AAPL'] }) });
  for (const f of w.listeners.alarm) f({ name: 'refresh-quotes' });
  await quiet(w.stub, 500);
  const q = (await w.get('quotes')).quotes.data.AAPL;
  check(`the card takes the close (${q.price}, ${q.changePct}%), not the 15:52 price`, q.price === 100 && q.changePct === 1.01, q);
  check('the separate extended-hours call fills in the line the quote could not', w.stub.counts.extended === 1, w.stub.counts);
};

SCENARIOS['an unreadable change field is deferred, not called offline'] = async () => {
  const at = etSept(15, 16, 25);
  const local = FULL(['AAPL'], at);
  Object.assign(local.quotes.data.AAPL, { at: etSept(15, 15, 52) });
  local.quotes.fetchedAt = etSept(15, 15, 52);
  const w = await boot({ at, local, stub: nasdaqStub({ session: 'after', unreadableChange: ['AAPL'] }) });
  for (const f of w.listeners.alarm) f({ name: 'refresh-quotes' });
  await quiet(w.stub, 500);
  const q = (await w.get('quotes')).quotes;
  check('the card keeps its last known price rather than a guess', q.data.AAPL.price === 100, q.data.AAPL);
  check('the footer is not told the source is offline', q.stale === false && !q.reason, { stale: q.stale, reason: q.reason });
  check('freshness is not claimed either', q.fetchedAt === etSept(15, 15, 52), q.fetchedAt);
  check('so the card is retried on the next alarm', !(q.data.AAPL.at >= etSept(15, 16, 20)));
};

SCENARIOS['Monday 4am rollover: a stale reference never replaces the close'] = async () => {
  const at = etSept(28, 4, 2);
  const local = FULL(['SHOP'], at);
  // Friday's settled close, as captured Friday evening
  Object.assign(local.quotes.data.SHOP, { price: 142.25, changePct: -2, prevClose: 145.16, at: etSept(25, 18) });
  const w = await boot({ at, local, stub: nasdaqStub({ session: 'pre' }) });
  // Nasdaq at 4:02am Monday: a pre-market trade measured against THURSDAY's close
  globalThis.fetch = async (u) => (/quote\/SHOP\/info/.test(String(u))
    ? { ok: true, status: 200, json: async () => ({ data: { marketStatus: 'Pre-Market', primaryData: { lastSalePrice: '$142.2716', netChange: '-2.8884', percentageChange: '-1.99%' } } }) }
    : w.stub.fetchImpl(u));
  await sendMessage(w.listeners, { type: 'refresh', reason: 'user' });
  await quiet(w.stub, 500);
  const q = (await w.get('quotes')).quotes.data.SHOP;
  check(`the card keeps Friday's close (${q.price}, ${q.changePct}%)`, q.price === 142.25 && q.changePct === -2, q);
};
SCENARIOS['cadence: on-demand refresh on a weekend'] = async () => {
  const at = etSept(19, 12);
  const w = await boot({ at, local: FULL(['AAPL', 'MSFT'], at) });
  await sendMessage(w.listeners, { type: 'refresh', reason: 'user' });
  await quiet(w.stub, 500);
  check(`clicking refresh works when the market is closed (${w.stub.counts.quote || 0} quotes)`, (w.stub.counts.quote || 0) >= 2, w.stub.counts);
};

// --- runner -----------------------------------------------------------------
const which = process.argv[2];
if (which) {
  try { await SCENARIOS[which](); } catch (e) { check(`${which} ran`, false, e.stack); }
  done(which);
} else {
  let failed = 0;
  let passed = 0;
  for (const name of Object.keys(SCENARIOS)) {
    section(name);
    const r = spawnSync(process.execPath, [SELF, name], { encoding: 'utf8', timeout: 120000 });
    const out = `${r.stdout}${r.stderr}`;
    for (const line of out.split('\n')) if (/^\s+(PASS|FAIL)/.test(line) || /^\s+->/.test(line)) console.log(line);
    passed += (out.match(/^\s+PASS/gm) || []).length;
    const f = (out.match(/^\s+FAIL/gm) || []).length;
    failed += f;
    if (r.status !== 0 && !f) { failed++; console.log(`  FAIL  scenario crashed (exit ${r.status})\n${out.slice(-1500)}`); }
  }
  console.log(`\nworker: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
