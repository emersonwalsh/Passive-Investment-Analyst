/**
 * Renderer parity + output safety.
 *
 * The page paints twice: first from boot.js (classic script, no imports, runs
 * before anything else so there is no blank frame), then newtab.js re-renders
 * with render.js and only touches the DOM if the markup differs. If the two
 * ever disagree, every tab open flashes or reflows. So the markup must be
 * byte-identical for every state a user can be in.
 *
 * Run under several timezones by tests/run.mjs, because "today" is computed
 * from the viewer's local calendar.
 */
import { imp, runBoot, check, section, done } from './lib.mjs';

const R = await imp('src/render.js');

const NOW = new Date(2026, 8, 16, 12, 0, 0).getTime();   // Wednesday, local noon
const iso = (days) => { const d = new Date(NOW); d.setDate(d.getDate() + days); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const LOGO = 'data:image/webp;base64,UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=';

function base() {
  return {
    v: 1, ready: true, theme: 'auto',
    showPrices: true, showCatalysts: true, showInsiders: true, showExtended: true,
    sort: { by: 'change', dir: 'desc' },
    symbols: ['AAPL', 'NVDA', 'INTC', 'JPM', 'SPY', 'ORCL'],
    meta: {
      AAPL: { name: 'Apple Inc.', exchange: 'NASDAQ', logo: LOGO },
      NVDA: { name: 'NVIDIA Corporation', exchange: 'NASDAQ' },
      INTC: { name: 'Intel Corporation', exchange: 'NASDAQ', logo: LOGO },
      JPM: { name: 'JPMorgan Chase & Co.', exchange: 'NYSE' },
      SPY: { name: 'SPDR S&P 500 ETF', exchange: 'NYSEARCA' },
      ORCL: { name: 'Oracle', exchange: null },
    },
    quotes: {
      fetchedAt: NOW - 4 * 60e3, fetchingSince: 0, stale: false, reason: null, unknown: {},
      data: {
        AAPL: { price: 332.27, changePct: 1.75, prevClose: 326.57 },
        NVDA: { price: 218.29, changePct: -0.03, prevClose: 218.36 },
        INTC: { price: 102.94, changePct: 2.61, prevClose: 100.32 },
        JPM: { price: 356.23, changePct: 0.76, prevClose: 353.56 },
        SPY: { price: 764.29, changePct: 0, prevClose: 764.29 },
        ORCL: { price: 211.1, changePct: -4.02, prevClose: 219.94 },
      },
    },
    catalysts: {
      fetchedAt: NOW - 3600e3, stale: false,
      data: {
        AAPL: [{ type: 'earnings', date: iso(43), timing: null, confirmed: false, epsEstimate: 1.98 }],
        NVDA: [{ type: 'earnings', date: iso(1), timing: 'amc', confirmed: true, epsEstimate: 2.47 }],
        INTC: [{ type: 'earnings', date: iso(36), timing: null, confirmed: false, epsEstimate: 0.28 }],
        JPM: [{ type: 'earnings', date: iso(4), timing: 'bmo', confirmed: true, epsEstimate: -0.12 }],
        SPY: [],
        ORCL: [{ type: 'earnings', date: iso(-2), timing: 'amc', confirmed: true, epsEstimate: 1.4 }],
      },
    },
    series: { fetchedAt: NOW - 600e3, data: { AAPL: [326, 328, 331, 332.27], NVDA: [219, 218.5, 218.29], INTC: [100, 101, 102.94] } },
    results: { fetchedAt: NOW - 600e3, data: { ORCL: { actual: 1.52, consensus: 1.4, surprisePct: 8.57 } } },
    insiders: {
      fetchedAt: NOW - 3600e3,
      data: { INTC: [{ who: 'Tan Lip Bu', role: 'Chief Executive Officer', date: iso(-5), days: 5, shares: 97000, price: 103.1, value: 10000700, stakePct: 8.7, isNew: false }] },
    },
    stale: false,
  };
}
const clone = (o) => structuredClone(o);
const mut = (fn) => { const c = base(); fn(c); return c; };

/** What newtab.js believes boot painted, computed exactly the way it does. */
function expected(c) {
  if (!c) return { up: '', hold: '' };                  // no mirror: boot paints nothing
  if (!c.ready) return { up: R.EMPTY_STATE, hold: null };
  const now = new Date(NOW);
  const showCat = c.showCatalysts !== false;
  const showPx = c.showPrices !== false;
  const upper = R.renderUpper(c.symbols || [], c.catalysts || { fetchedAt: 0, data: {} }, now,
    c.results || { data: {} }, c.insiders || { data: {} },
    { showCatalysts: showCat, showInsiders: c.showInsiders !== false });
  const up = !showCat && !showPx && !upper ? R.ALL_HIDDEN : (upper || '');
  const hold = showPx ? R.renderHoldings(c.symbols || [], c.quotes || { data: {} }, c.series || { data: {} }, c.meta || {}, NOW, c.sort) : null;
  return { up, hold };
}

const HOSTILE = '<img src=x onerror=alert(1)>"\'&<script>alert(2)</script>';
const CASES = [
  ['populated: confirmed + projected dates, insiders, reported', base()],
  ['no mirror at all (first tab after install)', null],
  ['cache present but not ready', mut((c) => { c.ready = false; })],
  ['only projected dates -> legend shown', mut((c) => { for (const k of Object.keys(c.catalysts.data)) for (const e of c.catalysts.data[k]) e.confirmed = false; c.results.data = {}; })],
  ['only confirmed dates -> no legend', mut((c) => { for (const k of Object.keys(c.catalysts.data)) for (const e of c.catalysts.data[k]) e.confirmed = true; })],
  ['legacy cache: confirmed null (pre-1.6 data)', mut((c) => { for (const k of Object.keys(c.catalysts.data)) for (const e of c.catalysts.data[k]) e.confirmed = null; })],
  ['projected date today and tomorrow', mut((c) => { c.catalysts.data.AAPL[0].date = iso(0); c.catalysts.data.INTC[0].date = iso(1); })],
  ['catalysts fetched, nothing upcoming', mut((c) => { for (const k of Object.keys(c.catalysts.data)) c.catalysts.data[k] = []; c.results.data = {}; })],
  ['catalysts never fetched (skeleton)', mut((c) => { c.catalysts = { fetchedAt: 0, stale: false, data: {} }; c.results.data = {}; })],
  ['catalysts never fetched and failed', mut((c) => { c.catalysts = { fetchedAt: 0, stale: true, data: {} }; c.results.data = {}; })],
  ['offline / stale', mut((c) => { c.stale = true; c.quotes.stale = true; c.quotes.reason = 'offline'; })],
  ['blocked by source', mut((c) => { c.stale = true; c.quotes.stale = true; c.quotes.reason = 'blocked'; })],
  ['fetch in flight, one card pending', mut((c) => { c.symbols.push('COIN'); c.quotes.fetchingSince = NOW - 5000; })],
  ['fetch aged out, card shows no data', mut((c) => { c.symbols.push('COIN'); c.quotes.fetchingSince = NOW - 120e3; })],
  ['first fetch still running', mut((c) => { c.quotes = { fetchedAt: 0, fetchingSince: NOW - 3000, data: {} }; })],
  ['unknown ticker', mut((c) => { c.symbols.push('ZZZZ'); c.quotes.unknown = { ZZZZ: true }; })],
  ['insiders hidden', mut((c) => { c.showInsiders = false; })],
  ['earnings hidden', mut((c) => { c.showCatalysts = false; })],
  ['prices hidden', mut((c) => { c.showPrices = false; })],
  ['earnings + insiders hidden, prices shown', mut((c) => { c.showCatalysts = false; c.showInsiders = false; })],
  ['everything hidden', mut((c) => { c.showCatalysts = false; c.showPrices = false; c.showInsiders = false; })],
  ['sort name asc', mut((c) => { c.sort = { by: 'name', dir: 'asc' }; })],
  ['sort name desc', mut((c) => { c.sort = { by: 'name', dir: 'desc' }; })],
  ['sort change asc', mut((c) => { c.sort = { by: 'change', dir: 'asc' }; })],
  ['missing sort (old cache)', mut((c) => { delete c.sort; })],
  ['extended hours present', mut((c) => { c.quotes.extPhase = 'after'; c.quotes.data.AAPL.ext = { price: 333.1, changePct: 0.25 }; c.quotes.data.NVDA.ext = { price: 217.9, changePct: -0.18 }; })],
  ['extended hours pre-market, partial', mut((c) => { c.quotes.extPhase = 'pre'; c.quotes.data.INTC.ext = { price: 103.5, changePct: 0.54 }; })],
  ['junk series values', mut((c) => { c.series.data = { AAPL: { points: [1, 2] }, NVDA: null, INTC: 'x', JPM: [], SPY: [5] }; })],
  ['negative, zero and tiny prices', mut((c) => { c.quotes.data.SPY = { price: 0.0034, changePct: -99.99, prevClose: 0.34 }; c.quotes.data.JPM = { price: 6160.76, changePct: 0, prevClose: 6160.76 }; })],
  ['NaN-ish and null fields', mut((c) => { c.quotes.data.AAPL = { price: 332.27, changePct: null, prevClose: null }; })],
  ['new insider position', mut((c) => { c.insiders.data.INTC[0].isNew = true; c.insiders.data.INTC[0].stakePct = null; })],
  ['insider without role or stake', mut((c) => { c.insiders.data.INTC[0].role = null; c.insiders.data.INTC[0].stakePct = null; })],
  ['25 symbols, over the row cap', mut((c) => {
    c.symbols = []; c.quotes.data = {}; c.catalysts.data = {};
    for (let i = 0; i < 25; i++) {
      const s = `S${String.fromCharCode(65 + i)}X`;
      c.symbols.push(s);
      c.quotes.data[s] = { price: 10 + i, changePct: i - 12, prevClose: 10 };
      c.catalysts.data[s] = [{ type: 'earnings', date: iso(2 + i), timing: i % 2 ? 'amc' : 'bmo', confirmed: i % 3 !== 0, epsEstimate: i / 10 }];
    }
  })],
  ['hostile strings from the API', mut((c) => {
    c.meta.AAPL.name = HOSTILE;
    c.insiders.data.INTC[0].who = HOSTILE;
    c.insiders.data.INTC[0].role = HOSTILE;
  })],
];

section(`renderer parity (TZ=${process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone})`);
for (const [name, cache] of CASES) {
  let b;
  try { b = runBoot(cache, NOW); } catch (e) { check(`${name}: boot.js runs`, false, e.stack); continue; }
  const e = expected(cache);
  const upOk = b.up === e.up;
  check(`${name}: upper`, upOk, upOk ? '' : diff(b.up, e.up));
  if (e.hold !== null) {
    const holdOk = b.hold === e.hold;
    check(`${name}: holdings`, holdOk, holdOk ? '' : diff(b.hold, e.hold));
  } else {
    check(`${name}: holdings hidden`, b.holdwrapClass === 'hide' || !(cache && cache.ready), b.holdwrapClass);
  }
}

section('first tab after install');
{
  const b = runBoot(null, NOW);
  check('a seeded user is never told to "add your first stock"', !/Add your first stock/.test(b.up + b.hold), b.up.slice(0, 120));
  check('the holdings column is not hidden (no one-to-two column jump)', b.holdwrapClass !== 'hide', b.holdwrapClass);
  const empty = runBoot(mut((c) => { c.ready = false; c.symbols = []; }), NOW);
  check('a user who really has no tickers still gets the empty state', /Add your first stock/.test(empty.up));
}

section('earnings surprises are stated proportionately');
{
  const withRes = (actual, consensus) => mut((c) => {
    c.results.data.ORCL = { actual, consensus, surprisePct: Math.round(((actual - consensus) / Math.abs(consensus)) * 1000) / 10 };
  });
  const rep = (c) => runBoot(c, NOW).up;
  check('a 4-cent miss on a $0.05 estimate reads in dollars, not "-80%"', /missed by \$0\.04/.test(rep(withRes(0.01, 0.05))) && !/80\.0%/.test(rep(withRes(0.01, 0.05))));
  check('a +575% swing reads in dollars', /beat by \$0\.46/.test(rep(withRes(0.54, 0.08))));
  check('an ordinary beat keeps its percentage', /beat 17\.3%/.test(rep(withRes(1.63, 1.39))));
  check('negative EPS is formatted with a real minus sign', /EPS &minus;\$0\.45 vs &minus;\$0\.30 est\./.test(rep(withRes(-0.45, -0.3))) && !/\$-/.test(rep(withRes(-0.45, -0.3))));
  check('a loss that narrowed is a beat', /beat/.test(rep(withRes(-0.08, -0.53))));
  check('the EPS basis is disclosed on the row', /title="Zacks EPS and consensus/.test(rep(withRes(1.63, 1.39))));
  // Nasdaq's holdings figure belongs to whichever account the purchase went
  // through (an Oracle director's trust read "+6410.3%"), so no stake is shown.
  const ins = runBoot(base(), NOW).up;
  check('insider rows show who, role and value — no stake percentage', /Tan Lip Bu &middot; Chief Executive Officer<\/span>/.test(ins) && !/%/.test(ins.match(/<li class="row buy[\s\S]*?<\/li>/)?.[0] || '%'), ins.match(/<li class="row buy[\s\S]*?<\/li>/)?.[0]);
  const newPos = runBoot(CASES.find(([n]) => n.startsWith('new insider'))[1], NOW).up;
  check('and no "new position" claim either', !/new (direct )?position/.test(newPos));
}

section('card names read as companies');
{
  const c = mut((x) => {
    x.meta.AAPL.name = 'Apple Inc. Common Stock';
    x.meta.JPM.name = 'Lennar Corporation Class A Common Stock';
    x.meta.NVDA.name = 'Stockholm Capital Shares Fund';
    x.meta.INTC.name = 'Taiwan Semiconductor Manufacturing Company Ltd. American Depositary Shares';
  });
  const hold = runBoot(c, NOW).hold;
  check('"Common Stock" is dropped from the card', />Apple Inc\.<\/span>/.test(hold) && !/Apple Inc\. Common Stock/.test(hold));
  check('"Class A Common Stock" is dropped', />Lennar Corporation<\/span>/.test(hold));
  check('ADR suffix is dropped', />Taiwan Semiconductor Manufacturing Company Ltd\.<\/span>/.test(hold));
  check('a company whose NAME contains those words is left alone', />Stockholm Capital Shares Fund<\/span>/.test(hold));
}

section('output safety');
{
  const c = CASES.find(([n]) => n.startsWith('hostile'))[1];
  const b = runBoot(c, NOW);
  const all = b.up + b.hold;
  check('no live <img> tag from a company or insider name', !/<img src=x/i.test(all));
  check('no live <script> tag', !/<script/i.test(all));
  check('quotes cannot break out of an attribute', !/"'&<script/.test(all) && !/onerror=alert\(1\)>"/.test(all));
  check('the text is still shown, escaped', all.includes('&lt;img src=x onerror=alert(1)&gt;'));
}

section('projected dates are honest');
{
  const b = runBoot(base(), NOW);
  const up = b.up;
  check('a projected date is marked with ~', /class="rel est"[^>]*>in ~43 days/.test(up), up.slice(0, 400));
  check('a confirmed date is not', /<span class="rel">tomorrow<\/span>/.test(up));
  check('screen readers hear "projected"', up.includes('<span class="vh"> (projected from past reporting dates)</span>'));
  check('nothing claims the company confirmed a date', !/confirmed/i.test(up), up.match(/.{40}confirmed.{40}/i)?.[0]);
  check('the ~ is explained on screen', up.includes('Projected from past reporting dates'));
  const none = runBoot(CASES.find(([n]) => n.startsWith('only confirmed'))[1], NOW);
  check('no legend when nothing is projected', !none.up.includes('Projected from past reporting dates'));
  const legacy = runBoot(CASES.find(([n]) => n.startsWith('legacy'))[1], NOW);
  check('unknown confirmation is treated as projected, never as scheduled', legacy.up.includes('class="rel est"'));
  const empty = runBoot(CASES.find(([n]) => n.startsWith('catalysts fetched, nothing'))[1], NOW);
  check('the empty state does not overclaim a 90-day window', !/90 days/.test(empty.up) && /No upcoming earnings dates published yet/.test(empty.up));
}

function diff(a, b) {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return `first difference at char ${i}\n        boot  : …${a.slice(Math.max(0, i - 60), i + 90)}\n        render: …${b.slice(Math.max(0, i - 60), i + 90)}`;
}

done('parity');
