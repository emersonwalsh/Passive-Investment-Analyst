/**
 * chrome.storage.local wrapper. Single source of truth for both the service
 * worker and the new tab page.
 */

export const SCHEMA_VERSION = 4;

/**
 * Seeded on first install so the very first new tab shows a working product
 * rather than an empty grid. Chosen to be broadly recognisable, liquid, and on
 * different reporting calendars so the earnings section is rarely empty.
 * Removing any of them is one click, and the choice is never re-applied.
 */
export const SEED_SYMBOLS = Object.freeze(['AAPL', 'NVDA', 'MSFT']);

export const DEFAULTS = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  symbols: [],
  meta: {},        // SYM -> { name, exchange } for card labels and Google Finance links
  settings: {
    apiKey: null, showPrices: true, showCatalysts: true, theme: 'auto',
    showInsiders: true, showExtended: true,
    sort: { by: 'change', dir: 'desc' },   // biggest movers first
  },
  quotes: { fetchedAt: 0, fetchingSince: 0, stale: false, reason: null, unknown: {}, data: {} },
  catalysts: { fetchedAt: 0, stale: false, data: {} },
  series: { fetchedAt: 0, stale: false, data: {} }, // SYM -> downsampled intraday closes
  results: { fetchedAt: 0, data: {} },  // SYM -> last reported quarter vs consensus
  insiders: { fetchedAt: 0, data: {} }, // SYM -> notable open-market purchases
  prefsAt: 0,      // last local preference change, for sync conflict ordering
});

// A bare `export ... from` is a re-export and creates NO local binding, so the
// value must be imported to be usable inside this module.
import { MAX_SYMBOLS } from './render.js';
export { MAX_SYMBOLS };

export async function getState() {
  const raw = await chrome.storage.local.get(null);
  return {
    schemaVersion: raw.schemaVersion ?? SCHEMA_VERSION,
    symbols: Array.isArray(raw.symbols) ? raw.symbols : [],
    meta: raw.meta || {},
    settings: { ...DEFAULTS.settings, ...(raw.settings || {}) },
    quotes: { ...DEFAULTS.quotes, ...(raw.quotes || {}) },
    catalysts: { ...DEFAULTS.catalysts, ...(raw.catalysts || {}) },
    series: { ...DEFAULTS.series, ...(raw.series || {}) },
    results: { ...DEFAULTS.results, ...(raw.results || {}) },
    insiders: { ...DEFAULTS.insiders, ...(raw.insiders || {}) },
    prefsAt: typeof raw.prefsAt === 'number' ? raw.prefsAt : 0,
  };
}

export async function patch(obj) {
  await chrome.storage.local.set(obj);
}

/**
 * Runs on install/startup. v1 only needs to seed defaults, but the version
 * check is the hook future migrations slot into.
 */
export async function migrate() {
  const raw = await chrome.storage.local.get(null);
  if (raw.schemaVersion === SCHEMA_VERSION && Array.isArray(raw.symbols)) return;

  if (raw.schemaVersion == null) {
    await chrome.storage.local.set({
      schemaVersion: SCHEMA_VERSION,
      // Seed only a genuinely fresh install — never overwrite an existing list.
      symbols: Array.isArray(raw.symbols) && raw.symbols.length ? raw.symbols : [...SEED_SYMBOLS],
      meta: {},
      settings: { ...DEFAULTS.settings, ...(raw.settings || {}) },
      quotes: { ...DEFAULTS.quotes },
      catalysts: { ...DEFAULTS.catalysts },
      series: { ...DEFAULTS.series },
    });
    return;
  }

  // v1 -> v2: sparkline series and per-symbol company/exchange metadata.
  // v2 -> v3: reported-earnings results. All backfill on the next refresh, so
  // seeding empties is enough.
  // v1->v2 series+meta, v2->v3 reported results, v3->v4 insider purchases.
  // All backfill on the next refresh, so seeding empties is enough.
  if (raw.schemaVersion >= 1 && raw.schemaVersion < SCHEMA_VERSION) {
    await chrome.storage.local.set({
      schemaVersion: SCHEMA_VERSION,
      meta: raw.meta || {},
      series: raw.series || { ...DEFAULTS.series },
      results: raw.results || { ...DEFAULTS.results },
      insiders: raw.insiders || { ...DEFAULTS.insiders },
    });
    return;
  }
  await chrome.storage.local.set({ schemaVersion: SCHEMA_VERSION });
}

export function normalizeSymbol(input) {
  return String(input || '').trim().toUpperCase().replace(/[^A-Z0-9.\-]/g, '').slice(0, 12);
}

export async function addSymbol(sym, info = null) {
  const s = normalizeSymbol(sym);
  const state = await getState();
  const { symbols } = state;
  if (!s || symbols.includes(s) || symbols.length >= MAX_SYMBOLS) return symbols;
  const next = [...symbols, s];
  const payload = {
    symbols: next,
    // Mark a fetch as expected right away so the new card reads as pending
    // rather than "No data" while the worker spins up. Ages out on its own.
    quotes: { ...state.quotes, fetchingSince: Date.now() },
  };
  if (info && (info.name || info.exchange)) {
    payload.meta = { ...state.meta, [s]: { name: info.name || null, exchange: info.exchange || null } };
  }
  await patch(payload);
  return next;
}

/** Removing a ticker must also drop its cached quote and catalyst rows. */
export async function removeSymbol(sym) {
  const state = await getState();
  const next = state.symbols.filter((s) => s !== sym);
  const quotes = { ...state.quotes, data: { ...state.quotes.data } };
  const catalysts = { ...state.catalysts, data: { ...state.catalysts.data } };
  const series = { ...state.series, data: { ...state.series.data } };
  const results = { ...state.results, data: { ...state.results.data } };
  const insiders = { ...state.insiders, data: { ...state.insiders.data } };
  const meta = { ...state.meta };
  delete quotes.data[sym];
  delete catalysts.data[sym];
  delete series.data[sym];
  delete results.data[sym];
  delete insiders.data[sym];
  delete meta[sym];
  await patch({ symbols: next, quotes, catalysts, series, results, insiders, meta });
  return next;
}

export async function reorderSymbols(next) {
  await patch({ symbols: next });
}
