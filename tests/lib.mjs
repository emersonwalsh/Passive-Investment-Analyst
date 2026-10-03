/**
 * Shared test helpers.
 *
 * These tests live OUTSIDE the extension folder on purpose: `catalyst/` is
 * exactly what gets zipped for the Chrome Web Store, and nothing here should
 * ever ride along into a user's browser.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const TESTS = path.dirname(fileURLToPath(import.meta.url));
// PIA_EXT points the suites at another copy, e.g. the unpacked store zip.
export const EXT = process.env.PIA_EXT ? path.resolve(process.env.PIA_EXT) : path.resolve(TESTS, '../catalyst');

/** Import an extension module. `bust` gives a fresh module instance. */
export const imp = (rel, bust = false) =>
  import(pathToFileURL(path.join(EXT, rel)).href + (bust ? `?t=${Math.random()}` : ''));

let passes = 0;
let fails = 0;
const failed = [];
export function section(title) { console.log(`\n${title}`); }
export function check(name, ok, detail) {
  if (ok) { passes++; console.log(`  PASS  ${name}`); return true; }
  fails++;
  failed.push(name);
  const d = detail === undefined ? '' : typeof detail === 'string' ? detail : JSON.stringify(detail);
  console.log(`  FAIL  ${name}${d ? `\n        -> ${d.slice(0, 900)}` : ''}`);
  return false;
}
export function done(label) {
  console.log(`\n${label}: ${passes} passed, ${fails} failed`);
  if (fails) console.log(`FAILED:\n  - ${failed.join('\n  - ')}`);
  process.exit(fails ? 1 : 0);
}

/** A fetch Response stand-in. */
export const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

/**
 * Run the real boot script (a classic, import-free script) against a cache
 * object, with a frozen clock, and return what it painted.
 */
const BOOT_SRC = fs.readFileSync(path.join(EXT, 'src/boot.js'), 'utf8');
export function runBoot(cache, nowMs) {
  const els = {};
  const el = (id) => (els[id] ||= {
    id, innerHTML: '', textContent: '', className: id === 'up' ? 'sec' : '',
    style: { setProperty() {} }, setAttribute() {}, removeAttribute() {},
  });
  const ls = { 'cache:v1': cache == null ? null : JSON.stringify(cache) };
  const RealDate = Date;
  class FixedDate extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(nowMs); }
    static now() { return nowMs; }
  }
  const ctx = vm.createContext({
    document: { getElementById: el, documentElement: { setAttribute() {} }, body: { style: { setProperty() {} } } },
    localStorage: { getItem: (k) => (k in ls ? ls[k] : null) },
    performance: { now: () => 0 },
    window: {},
    console,
    Date: FixedDate,
  });
  vm.runInContext(BOOT_SRC, ctx, { filename: 'boot.js' });
  return {
    up: el('up').innerHTML, upClass: el('up').className,
    hold: el('hold').innerHTML, holdwrapClass: el('holdwrap').className,
    upd: el('upd').textContent,
  };
}

/**
 * Chrome-extension API stand-in. Both storage areas fire onChanged
 * asynchronously after a write — including for the extension's OWN sync writes,
 * exactly as Chrome does, because that echo is a real source of bugs.
 */
export function fakeChrome(initial = {}, initialSync = {}) {
  const areas = { local: structuredClone(initial), sync: structuredClone(initialSync) };
  const listeners = { installed: [], startup: [], alarm: [], message: [], changed: [] };
  const alarms = {};
  const area = (name) => {
    const store = areas[name];
    const pick = (k) => (k == null ? structuredClone(store)
      : typeof k === 'string' ? (k in store ? { [k]: structuredClone(store[k]) } : {})
        : Array.isArray(k) ? Object.fromEntries(k.filter((x) => x in store).map((x) => [x, structuredClone(store[x])]))
          : Object.fromEntries(Object.keys(k).map((x) => [x, x in store ? structuredClone(store[x]) : k[x]])));
    return {
      get: async (k) => pick(k),
      set: async (o) => {
        const changes = {};
        for (const [k, v] of Object.entries(o)) {
          if (JSON.stringify(store[k]) === JSON.stringify(v)) continue;   // Chrome skips no-op writes
          changes[k] = { oldValue: store[k], newValue: structuredClone(v) };
          store[k] = structuredClone(v);
        }
        if (Object.keys(changes).length) setTimeout(() => { for (const f of listeners.changed) f(changes, name); }, 0);
      },
      remove: async (k) => { for (const x of [].concat(k)) delete store[x]; },
      clear: async () => { for (const x of Object.keys(store)) delete store[x]; },
    };
  };
  const chrome = {
    runtime: {
      id: 'test',
      onInstalled: { addListener: (f) => listeners.installed.push(f) },
      onStartup: { addListener: (f) => listeners.startup.push(f) },
      onMessage: { addListener: (f) => listeners.message.push(f) },
      getPlatformInfo: async () => ({ os: 'mac' }),
      lastError: null,
    },
    alarms: {
      create: async (name, o) => { alarms[name] = o; },
      get: async (name) => (alarms[name] ? { name, ...alarms[name] } : undefined),
      getAll: async () => Object.entries(alarms).map(([name, o]) => ({ name, ...o })),
      clear: async (name) => delete alarms[name],
      onAlarm: { addListener: (f) => listeners.alarm.push(f) },
    },
    storage: {
      local: area('local'), sync: area('sync'),
      onChanged: { addListener: (f) => listeners.changed.push(f) },
    },
  };
  return { chrome, store: areas.local, syncStore: areas.sync, listeners, alarms };
}

/**
 * A clock that only moves forward and never stops ticking. Freezing Date.now()
 * deadlocks the request gate, which paces itself on elapsed time.
 */
export function installClock(startMs) {
  const RealDate = Date;
  let offset = startMs - RealDate.now();
  const now = () => RealDate.now() + offset;
  globalThis.Date = class extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(now()); }
    static now() { return now(); }
  };
  return {
    now,
    advance(ms) { if (ms < 0) throw new Error('clock must not go backwards'); offset += ms; },
    to(ms) { if (ms < now()) throw new Error('clock must not go backwards'); offset = ms - RealDate.now(); },
  };
}

/** US Eastern wall time -> epoch ms (September, so EDT = UTC-4). */
export const etSept = (day, h, m = 0) => Date.UTC(2026, 8, day, h + 4, m);

/**
 * Nasdaq stand-in with realistic payload shapes and a request counter per
 * endpoint kind. `earnings[SYM]` = "MM/DD/YYYY after market close" for a
 * confirmed date, "error" to fail the lookup, or absent for a vendor gap.
 */
export function nasdaqStub({ etfs = [], earnings = {}, failQuotes = [], session = null, emptyChange = [], unreadableChange = [] } = {}) {
  const counts = {};
  const urls = [];
  const hit = (k, u) => { counts[k] = (counts[k] || 0) + 1; urls.push(`${k} ${u.replace(/^https:\/\/[^/]+/, '')}`); };
  const fetchImpl = async (u) => {
    const url = String(u);
    let m;
    if (/financialmodelingprep|finnhub/.test(url)) { hit('logo', url); return json({}, 404); }
    if ((m = /quote\/([A-Z.]+)\/info\?assetclass=(\w+)/.exec(url))) {
      hit('quote', url);
      const [, s, cls] = m;
      if (failQuotes.includes(s)) throw new TypeError('Failed to fetch');
      if ((cls === 'etf') !== etfs.includes(s)) return json({ data: null });
      // Shaped like the real thing in each session (see tests/quotes.test.mjs):
      // regular/closed -> price vs previous close (100.00 vs 99.00);
      // pre/after -> the EXTENDED trade measured against the regular close
      // (100.50 vs a 100.00 close). `emptyChange` symbols answer with no change
      // field, as Nasdaq does for a while after the bell.
      const ext = session === 'pre' || session === 'after';
      const status = { pre: 'Pre-Market', after: 'After-Hours', open: 'Open', closed: 'Closed' }[session];
      // An empty change field carries the regular close as `last` (as observed live).
      const primaryData = emptyChange.includes(s)
        ? { lastSalePrice: '$100.00', netChange: '', percentageChange: '' }
        : unreadableChange.includes(s) ? { lastSalePrice: '$100.50', netChange: 'N/A', percentageChange: 'N/A' }
        : ext ? { lastSalePrice: '$100.50', netChange: '+0.50', percentageChange: '+0.50%' }
          : { lastSalePrice: '$100.00', netChange: '+1.00', percentageChange: '+1.01%' };
      return json({ data: { symbol: s, companyName: `${s} Inc.`, exchange: etfs.includes(s) ? 'PSE' : 'NASDAQ-GS',
        ...(status ? { marketStatus: status } : {}), primaryData } });
    }
    if (/\/extended-trading/.test(url)) { hit('extended', url); return json({ data: { infoTable: { rows: [{ consolidated: '$101.50 +1.50 (+1.50%)' }] } } }); }
    if ((m = /quote\/([A-Z.]+)\/chart\?assetclass=(\w+)/.exec(url))) {
      hit(`chart:${m[2]}`, url);
      if ((m[2] === 'etf') !== etfs.includes(m[1])) return json({ data: null });
      return json({ data: { company: `${m[1]} Inc.`, exchange: 'NASDAQ-GS', chart: [{ y: 99 }, { y: 100 }, { y: 101 }] } });
    }
    if ((m = /analyst\/([A-Z.]+)\/earnings-date/.exec(url))) {
      hit('earnings-date', url);
      const e = earnings[m[1]];
      if (e === 'error') throw new TypeError('Failed to fetch');
      if (!e) return json({ data: { reportText: "Our vendor, Zacks Investment Research, hasn't provided us with the upcoming earnings report date." } });
      return json({ data: { reportText: `${m[1]} Inc. Common Stock is expected* to report earnings on ${e}. ` } });
    }
    if (/\/eps$/.test(url)) { hit('eps', url); return json({ data: { earningsPerShare: [] } }); }
    if (/calendar\/earnings/.test(url)) { hit('calendar-day', url); return json({ data: { asOf: 'x', rows: [{ symbol: 'ZZZZ', time: 'time-not-supplied' }] } }); }
    if (/insider-trades/.test(url)) { hit('insiders', url); return json({ data: { transactionTable: { table: { rows: [] } } } }); }
    if (/autocomplete/.test(url)) { hit('search', url); return json({ data: [] }); }
    hit('other', url);
    return json({}, 404);
  };
  return {
    fetchImpl, counts, urls,
    total: () => Object.values(counts).reduce((a, b) => a + b, 0),
    reset() { for (const k of Object.keys(counts)) delete counts[k]; urls.length = 0; },
  };
}

/** Send a runtime message to the worker the way Chrome would. */
export function sendMessage(listeners, msg) {
  return new Promise((resolve) => {
    let replied = false;
    const r = listeners.message[0](msg, {}, (v) => { replied = true; resolve(v); });
    if (r !== true && !replied) resolve(undefined);
  });
}

/** Wait until `pred()` is truthy, or give up. */
export async function until(pred, ms = 8000, step = 25) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await pred()) return true; await new Promise((r) => setTimeout(r, step)); }
  return false;
}
