/**
 * Finnhub adapter. Everything network-shaped lives behind this file; callers
 * only ever see the normalized shapes below.
 *
 *   getQuotes(symbols, apiKey)
 *     -> { AAPL: { price, changePct, prevClose } }
 *   getCatalysts(symbols, apiKey)
 *     -> { AAPL: [{ type, date, timing, confirmed, epsEstimate }] }
 *
 * Missing fields are null, never absent.
 */

import { etDateStr } from '../market-hours.js';
import * as nasdaq from './nasdaq.js';
import { gatedFetch } from '../net.js';

const BASE = 'https://finnhub.io/api/v1';
const CONCURRENCY = 3;      // free tier is 60 req/min AND bursty callers get 429s
const RETRY_429 = 2;
const TIMEOUT_MS = 10000;      // background fetches
const INTERACTIVE_TIMEOUT_MS = 6000; // settings-panel checks, where a user is waiting
const HORIZON_DAYS = 90;    // a full quarter, so every symbol shows its next report
                            // (a date range costs the same one request either way)

/** Thrown when the key is valid but the plan doesn't cover the endpoint. */
export class PremiumRequiredError extends Error { code = 'premium'; }
export class AuthError extends Error { code = 'auth'; }
export class RateLimitError extends Error { code = 'rate'; }
export class HttpError extends Error {
  constructor(status) { super(`HTTP ${status}`); this.status = status; this.code = 'http'; }
}

/** Short, loggable description of a failure. Never includes the URL or key. */
export function describeError(err) {
  if (!err) return 'unknown';
  if (err.status) return `HTTP ${err.status}`;
  if (err.code) return err.code;
  if (err.name === 'AbortError') return 'timeout';
  if (err.name === 'TypeError') return 'network';
  return `${err.name}: ${String(err.message).slice(0, 60)}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url, signal, timeoutMs = TIMEOUT_MS, attempt = 0) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  let retryAfterMs = null;
  try {
    const res = await gatedFetch(url, { signal: ctrl.signal });
    if (res.status === 401) throw new AuthError('Invalid API key');
    if (res.status === 403) throw new PremiumRequiredError('Endpoint not available on this plan');
    if (res.status === 429) {
      // Bursting past the free tier's 60/min is easy when the user adds tickers
      // or force-refreshes. Back off and retry rather than dropping the symbol.
      if (attempt >= RETRY_429) throw new RateLimitError('Rate limited');
      retryAfterMs = (Number(res.headers.get('Retry-After')) * 1000) || 800 * (attempt + 1);
    } else {
      if (!res.ok) throw new HttpError(res.status);
      return await res.json();
    }
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
  await sleep(retryAfterMs);
  return getJSON(url, signal, timeoutMs, attempt + 1);
}

/** getJSON plus one retry for transient network/timeout errors. */
async function getJSONRetrying(url, signal, timeoutMs = TIMEOUT_MS) {
  try {
    return await getJSON(url, signal, timeoutMs);
  } catch (err) {
    const transient = err?.name === 'TypeError' || err?.name === 'AbortError'
      || (err?.status >= 500 && err?.status <= 599);
    if (!transient) throw err;
    await sleep(600);
    return getJSON(url, signal, timeoutMs);
  }
}

/** Bounded-concurrency map. Keeps us politely inside the rate limit. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

async function finnhubQuotes(symbols, apiKey, { signal, onError } = {}) {
  if (!apiKey || !symbols.length) return {};
  const out = {};
  let authFailed = null;
  let rateLimited = null;

  await mapLimit(symbols, CONCURRENCY, async (sym) => {
    if (authFailed) return;
    try {
      const j = await getJSONRetrying(
        `${BASE}/quote?symbol=${encodeURIComponent(sym)}&token=${encodeURIComponent(apiKey)}`,
        signal,
      );
      // Finnhub answers unknown symbols with an all-zero payload.
      if (!j || (j.c === 0 && j.pc === 0)) { onError?.(sym, 'no-data'); return; }
      out[sym] = { price: num(j.c), changePct: num(j.dp), prevClose: num(j.pc) };
    } catch (err) {
      if (err instanceof AuthError) authFailed = err;
      else if (err instanceof RateLimitError) rateLimited = err;
      onError?.(sym, describeError(err));
      // otherwise: leave this symbol out, keep whatever is cached
    }
  });

  // Only surface a failure if it cost us everything. Discarding good quotes
  // because one symbol failed is what made the whole grid go stale.
  if (!Object.keys(out).length) {
    if (authFailed) throw authFailed;
    if (rateLimited) throw rateLimited;
  }
  return out;
}

const TIMING = { bmo: 'bmo', amc: 'amc', dmh: 'dmt' };

async function finnhubCatalysts(symbols, apiKey, { signal } = {}) {
  if (!symbols.length) return {};
  const from = etDateStr(0);
  const to = etDateStr(HORIZON_DAYS);
  const out = {};
  for (const s of symbols) out[s] = [];

  let denied = null;
  let authFailed = null;

  await mapLimit(symbols, CONCURRENCY, async (sym) => {
    if (denied || authFailed) return;
    try {
      const j = await getJSON(
        `${BASE}/calendar/earnings?from=${from}&to=${to}&symbol=${encodeURIComponent(sym)}`
        + `&token=${encodeURIComponent(apiKey)}`,
        signal,
      );
      const rows = Array.isArray(j?.earningsCalendar) ? j.earningsCalendar : [];
      out[sym] = rows
        .filter((r) => r && typeof r.date === 'string')
        .sort((a, b) => (a.date < b.date ? -1 : 1))
        .slice(0, 1) // only the next one matters for a glanceable list
        .map((r) => ({
          type: 'earnings',
          date: r.date,
          timing: TIMING[r.hour] ?? null,
          confirmed: null, // Finnhub doesn't expose confirmed-vs-estimated
          epsEstimate: num(r.epsEstimate),
        }));
    } catch (err) {
      if (err instanceof PremiumRequiredError) denied = err;
      else if (err instanceof AuthError) authFailed = err;
    }
  });

  if (authFailed) throw authFailed;

  // Plan doesn't include the calendar — swap to the public Nasdaq feed rather
  // than shipping an empty primary section.
  if (denied) return nasdaq.getCatalysts(symbols, null, { signal });
  return out;
}

/** Settings panel: immediate "key works / key rejected" after paste. */
export async function validateKey(apiKey, { signal } = {}) {
  if (!apiKey) return { ok: false, reason: 'empty' };
  try {
    const j = await getJSON(`${BASE}/quote?symbol=AAPL&token=${encodeURIComponent(apiKey)}`,
      signal, INTERACTIVE_TIMEOUT_MS);
    if (!j || typeof j.c !== 'number') return { ok: false, reason: 'unexpected' };
    return { ok: true };
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, reason: 'rejected' };
    return { ok: false, reason: 'network' };
  }
}

/** Settings panel: a ticker must resolve before we save it. */
export async function validateSymbol(sym, apiKey, { signal } = {}) {
  try {
    const j = await getJSON(
      `${BASE}/quote?symbol=${encodeURIComponent(sym)}&token=${encodeURIComponent(apiKey)}`,
      signal, INTERACTIVE_TIMEOUT_MS,
    );
    if (!j || typeof j.c !== 'number') return { ok: false, reason: 'unexpected' };
    if (j.c === 0 && j.pc === 0) return { ok: false, reason: 'unknown' };
    return { ok: true, quote: { price: num(j.c), changePct: num(j.dp), prevClose: num(j.pc) } };
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, reason: 'auth' };
    return { ok: false, reason: 'network' };
  }
}

/**
 * Quotes: keyless by default.
 *
 * Nasdaq's quote endpoint was verified to return the same price, net change and
 * percent as Finnhub, so an API key is an optional reliability upgrade rather
 * than a requirement. Without a key we go straight to Nasdaq; with one we use
 * Finnhub and fall back to Nasdaq if it returns nothing at all, so a rejected
 * key degrades to working data instead of an empty grid.
 */
export async function getQuotes(symbols, apiKey, opts = {}) {
  if (!apiKey) return nasdaq.getQuotes(symbols, null, opts);
  try {
    const out = await finnhubQuotes(symbols, apiKey, opts);
    if (Object.keys(out).length) return out;
    opts.onError?.('*', 'finnhub-empty');
  } catch (err) {
    // ANY Finnhub failure degrades to the keyless source. A user with a bad or
    // rate-limited key should still see prices; the reason is recorded in diag
    // rather than surfaced as an outage.
    opts.onError?.('*', `${err?.code || 'error'}-fallback`);
  }
  return nasdaq.getQuotes(symbols, null, opts);
}

/** Catalysts: without a key, skip the guaranteed Finnhub 401 entirely. */
export async function getCatalysts(symbols, apiKey, opts = {}) {
  if (!apiKey) return nasdaq.getCatalysts(symbols, null, opts);
  return finnhubCatalysts(symbols, apiKey, opts);
}

/* Sparkline series and symbol search come from Nasdaq: both are keyless, which
   means autocomplete works before the user has entered an API key. Kept behind
   this module so callers still see a single provider. */
export const getSeries = nasdaq.getSeries;
export const searchSymbols = nasdaq.searchSymbols;
export const googleExchange = nasdaq.googleExchange;

export const id = 'finnhub';
export const signupUrl = 'https://finnhub.io/register';

/* Logos come from a dedicated keyless module with two independent CDNs.
   Kept behind this provider so callers still see one interface. */
export { getLogos } from './logos.js';

/* Extended-hours prices are keyless and Nasdaq-only. */
export const getExtended = nasdaq.getExtended;
export const getEarningsResults = nasdaq.getEarningsResults;
export const getInsiderBuys = nasdaq.getInsiderBuys;
export const verifySymbol = nasdaq.verifySymbol;
export { isNotableBuy , scanDays, scanGaps } from './nasdaq.js';
