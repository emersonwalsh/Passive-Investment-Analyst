/**
 * Nasdaq's public earnings calendar — the fallback when a key can't reach
 * Finnhub's calendar endpoint. Unofficial and undocumented, so every failure
 * is swallowed into "no data" rather than surfaced.
 *
 * Indexed by date, not symbol, so covering a horizon costs one request per
 * weekday. Acceptable at once-per-day; never used for quotes.
 */

import { etDateStr } from '../market-hours.js';
import { gatedFetch } from '../net.js';

const BASE = 'https://api.nasdaq.com/api/calendar/earnings';
// Measured: Nasdaq's calendar is well populated to ~45 days out and empty
// beyond ~50, so scanning to 90 would burn ~28 requests a day on empty responses.
// The Finnhub path keeps the full 90-day window because a date range costs it
// one request either way.
// The per-symbol lookup publishes dates further out than the day-scan can see,
// so it gets the full quarter. The scan keeps the shorter window because Nasdaq
// simply has no calendar data past ~50 days.
const SYMBOL_HORIZON_DAYS = 92;
const HORIZON_DAYS = 92;      // matches the per-symbol horizon; the frontier check ends it sooner
const MAX_DAY_REQUESTS = 45;  // hard ceiling; the loop also exits once every symbol is found
/**
 * Nasdaq's calendar is only populated a few weeks out, and the far edge is a
 * long tail of genuinely empty days. Rather than burn requests on dates the
 * source has not filled in yet, stop once we have seen this many consecutive
 * empty weekdays — that is the data frontier, not a gap in our reading.
 *
 * This has to clear the widest *legitimate* quiet stretch inside the calendar,
 * not just the first lull. Between reporting seasons a week of thin days is
 * ordinary, and stopping there would abandon the scan short of real dates and
 * report "nothing upcoming" — the same false negative from the other side. Two
 * full weeks of complete silence is the frontier; the request ceiling bounds
 * the cost either way.
 */
const EMPTY_RUN_STOP = 10;

/** Which dates the last scan could not read. Diagnostic only. */
let lastScanGaps = [];
export const scanGaps = () => lastScanGaps;

/** How many day requests the last call actually made. 0 means no scan ran. */
let lastScanDays = 0;
export const scanDays = () => lastScanDays;

const TIMING = {
  'time-pre-market': 'bmo',
  'time-after-hours': 'amc',
  'time-not-supplied': null,
};

function parseEps(v) {
  if (typeof v !== 'string' || !v) return null;
  const neg = v.includes('(');
  const n = Number(v.replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}

/** @returns rows, or null when the day could not be loaded at all. */
async function fetchDay(dateStr, signal) {
  const res = await gatedFetch(`${BASE}?date=${dateStr}`, {
    signal,
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) return null;
  const json = await res.json();
  const rows = json?.data?.rows;
  // A valid day with no earnings is [], which is a real answer. A malformed
  // body is not, and must not be mistaken for one.
  //
  // Nasdaq expresses "nothing that day" two different ways, and only one of
  // them was recognised. The other — data present with `asOf` set for the date
  // but `rows: null` — was read as malformed, which marked the whole scan
  // incomplete; because a single unreadable day withholds every symbol, one
  // quiet Friday was enough to blank the entire earnings calendar.
  if (rows === null || rows === undefined) {
    if (json?.data === null) return [];                          // "No record found"
    if (json?.data && 'asOf' in json.data) return [];            // answered for the date, no rows
    return null;                                                 // genuinely unrecognisable
  }
  return Array.isArray(rows) ? rows : null;
}

/** Matches the provider interface: symbols -> normalized catalyst lists. */
/** Consensus EPS for the next quarter, from the same endpoint as reported results. */
async function fetchUpcomingEstimate(sym, signal) {
  try {
    const res = await gatedFetch(`https://api.nasdaq.com/api/quote/${encodeURIComponent(sym)}/eps`,
      { signal, headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const rows = (await res.json())?.data?.earningsPerShare;
    if (!Array.isArray(rows)) return null;
    const next = rows.find((r) => r?.type === 'UpcomingQuarter' && typeof r.consensus === 'number');
    return next ? next.consensus : null;
  } catch {
    return null;
  }
}

/**
 * Per-symbol earnings date. One request per symbol instead of scanning the
 * whole calendar day by day, which cut a typical refresh from ~36 Nasdaq
 * requests to 4 — and reaches further out, since this endpoint publishes dates
 * beyond the ~50 days the day-scan can see.
 *
 * The payload is prose ("...expected* to report earnings on 10/22/2026 after
 * market close..."), so parsing is deliberately strict: no confident match
 * means "unknown", never a guess.
 *
 * @returns {date, timing} | 'none' | null   (null = could not read)
 */
async function fetchSymbolDate(sym, signal) {
  try {
    const res = await gatedFetch(
      `https://api.nasdaq.com/api/analyst/${encodeURIComponent(sym)}/earnings-date`,
      { signal, headers: { Accept: 'application/json' } },
    );
    if (!res.ok) return null;
    const text = (await res.json())?.data?.reportText;
    if (typeof text !== 'string') return null;
    const m = /\bon\s+(\d{1,2})\/(\d{1,2})\/(\d{4})\b/.exec(text);
    if (!m) return 'none';                       // read fine; no date published
    const iso = `${m[3]}-${String(+m[1]).padStart(2, '0')}-${String(+m[2]).padStart(2, '0')}`;
    const timing = /before\s+market\s+open/i.test(text) ? 'bmo'
      : /after\s+market\s+close/i.test(text) ? 'amc' : null;
    // Zacks words two cases differently. "is estimated to report" is a
    // projection "derived from an algorithm based on a company's historical
    // reporting dates": against an independent source only 17 of 28 matched,
    // often a week out (MSFT, GOOGL, META all listed a week late). Those are
    // marked "~" on screen.
    //
    // "is expected* to report" is Zacks' listed date, usually the company's own
    // announcement — but NOT a guarantee: 55 of 58 matched, and Wells Fargo's
    // Q3 2026 date was a day late against the company's own investor-relations
    // page. So `confirmed` here means "not a projection", and nothing on screen
    // claims the company confirmed it.
    const confirmed = /\bexpected\*?\s+to\s+report/i.test(text);
    return { date: iso, timing, confirmed };
  } catch {
    return null;
  }
}

/**
 * Matches the provider interface: symbols -> normalized catalyst lists.
 *
 * An EMPTY array here means "checked the whole window, nothing scheduled", and
 * the caller trusts that enough to overwrite its cache. So if any day in the
 * scan failed to load, the scan is incomplete and must NOT make that claim —
 * symbols without a hit are omitted instead, leaving cached dates intact.
 * Getting this wrong made earnings rows appear and vanish between refreshes.
 */
export async function getCatalysts(symbols, _apiKey, { signal, allowScan = true } = {}) {
  const wanted = new Set(symbols);
  const found = {};

  // Weekdays only — the calendar is empty on weekends.
  const dates = [];
  for (let i = 0; i <= HORIZON_DAYS && dates.length < MAX_DAY_REQUESTS; i++) {
    const d = etDateStr(i);
    const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) dates.push(d);
  }

  // Try the cheap per-symbol lookup first; only fall back to scanning the
  // calendar for symbols it could not resolve.
  let complete = true;
  let hits = 0;
  const today = etDateStr(0);
  const horizon = etDateStr(SYMBOL_HORIZON_DAYS);
  await mapLimit(symbols, QUOTE_CONCURRENCY, async (sym) => {
    const r = await fetchSymbolDate(sym, signal);
    // A miss here is not a gap in our knowledge — the calendar scan below is
    // the authority, and it covers every symbol. Letting one unreadable
    // per-symbol lookup (an ETF has no earnings endpoint at all) mark the
    // whole read incomplete caused every other symbol to be omitted too.
    if (r === null) return;                         // unread — leave for the scan
    // 'none' is this endpoint saying its vendor has not published a date yet.
    // That is NOT the same as "no earnings scheduled". Treating it as fact used
    // to resolve every symbol to [] and, because it also counted as a hit,
    // suppressed the calendar scan entirely — so a whole watchlist reported
    // nothing upcoming while the calendar plainly had the dates. Leave these
    // unresolved and let the scan answer.
    if (r === 'none') return;
    if (r.date < today || r.date > horizon) { found[sym] = []; hits++; return; }
    found[sym] = [{ type: 'earnings', date: r.date, timing: r.timing, confirmed: r.confirmed, epsEstimate: null }];
    hits++;
  });

  // Attach the consensus estimate only for symbols that actually have a date.
  const dated = symbols.filter((s2) => found[s2]?.length);
  if (dated.length) {
    await mapLimit(dated, QUOTE_CONCURRENCY, async (sym) => {
      const est = await fetchUpcomingEstimate(sym, signal);
      if (est != null && found[sym]?.[0]) found[sym][0].epsEstimate = est;
    });
  }

  let emptyRun = 0;
  const gaps = [];
  lastScanDays = 0;
  // The day-by-day scan is by far the most expensive thing this extension does
  // — up to 45 requests to a single bot-protected host. Adding a ticker used to
  // force one, so adding several in a row fired hundreds of requests in a few
  // minutes and got the browser soft-blocked. When scanning is not allowed we
  // simply do not claim to know: unresolved symbols stay unchecked and the next
  // scheduled scan fills them in.
  for (const date of (allowScan ? dates : [])) {
    if (hits >= wanted.size) break;          // every symbol already has its next date
    let rows;
    try {
      rows = await fetchDay(date, signal);
    } catch (e) {
      complete = false;                      // a gap means we cannot claim "nothing"
      gaps.push([date, e?.code || e?.name || 'err']);
      continue;
    }
    lastScanDays++;
    if (rows === null) { complete = false; gaps.push([date, 'bad-body']); continue; }
    // Past the frontier the calendar returns real, empty days. Reading every
    // one of them costs requests and tells us nothing; stopping here still
    // counts as a complete read, because we have seen everything the source
    // actually holds.
    if (rows.length === 0) {
      if (++emptyRun >= EMPTY_RUN_STOP) break;
      continue;
    }
    emptyRun = 0;
    for (const r of rows) {
      const sym = String(r?.symbol || '').toUpperCase();
      if (!wanted.has(sym) || found[sym]) continue;   // already resolved above
      found[sym] = [{
        type: 'earnings',
        date,
        timing: TIMING[r.time] ?? null,
        // The calendar feed carries no confirmation flag, and it lists Zacks'
        // algorithmic projections alongside announced dates. Understating is
        // harmless; presenting a projection as scheduled is not.
        confirmed: false,
        epsEstimate: parseEps(r.epsForecast),
      }];
      hits++;
    }
  }

  // Skipping the scan is not the same as reading nothing: without a scan we
  // have not looked, so we must not claim "nothing scheduled" for a symbol the
  // cheap lookup could not resolve.
  if (!allowScan && symbols.some((s2) => !found[s2])) complete = false;
  lastScanGaps = gaps;   // always, so a stale list can never be read as current
  const out = {};
  for (const s of symbols) {
    if (found[s]) out[s] = found[s];
    else if (complete) out[s] = [];          // only claim "nothing" after a clean read
    // otherwise: omit, so the caller keeps whatever it had
  }
  return out;
}

export const id = 'nasdaq';

/* ------------------------------------------------------------------ quotes */

const QUOTE_CONCURRENCY = 4;

/**
 * Parses Nasdaq's display-formatted numbers: "$756,650.01", "-1,335.00",
 * "+0.05%", "N/A". Returns null for anything that isn't a real number.
 */
function parseNum(v) {
  if (typeof v !== 'string') return null;
  const cleaned = v.replace(/[$,%\s]/g, '').replace(/^\+/, '');
  if (!cleaned) return null;          // Number('') is 0, which would read as a real price
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Keyless quotes. Verified to match Finnhub exactly on price, net change and
 * percent; `previousClose` is derived as price - netChange, which reproduces
 * Finnhub's `pc` to the cent.
 *
 *   -> { AAPL: { price, changePct, prevClose } }
 *
 * ETFs are only served under assetclass=etf, so the class is tried in order and
 * the working one is reported back through `onMeta` to make later fetches
 * single-request. An unknown symbol answers HTTP 200 with `data: null`, so the
 * body must be inspected rather than the status alone.
 */
/**
 * Which session a quote payload describes. Nasdaq's own label wins, because our
 * clock does not know about half-days: on the day after Thanksgiving the market
 * closes at 13:00 and everything after is extended trading, while a calendar
 * says "open".
 */
export function quoteFrame(marketStatus, phase) {
  const s = String(marketStatus || '');
  if (/open/i.test(s)) return 'regular';
  if (/pre|after|extended/i.test(s)) return 'extended';
  return phase === 'pre' || phase === 'after' ? 'extended' : 'regular';
}

const round4 = (v) => Math.round(v * 1e4) / 1e4;
/** "UNCH" means unchanged, which is a number, not a missing value. */
const netOf = (v) => (/unch/i.test(String(v ?? '')) ? 0 : parseNum(v));

/**
 * A quote only means something together with the session it was taken in.
 *
 * During pre-market and after-hours, `primaryData` is the EXTENDED trade, and
 * its netChange/percentageChange are measured against the most recent REGULAR
 * close — not against the previous day's. Read as an ordinary quote it puts the
 * after-hours price in the day's slot and replaces the day's move with the
 * after-hours move. Observed: SHOP showed 130.00 +0.11% while that session had
 * closed at 129.86, down 3.01%.
 *
 * In an extended session the regular close is therefore `last - net`. The day's
 * move needs the previous close, which extended trading cannot change — so the
 * one already stored is the right one, and the extended figures come free.
 */
export function readQuote(data, { extended, prevCloseHint, priceHint, guardRollover = false } = {}) {
  const p = data?.primaryData;
  if (!p) return null;
  const last = parseNum(p.lastSalePrice);
  if (last == null) return null;
  const net = netOf(p.netChange);
  const pct = parseNum(p.percentageChange);

  if (!extended) return { price: last, changePct: pct, prevClose: net == null ? null : round4(last - net) };

  // An EMPTY change field means Nasdaq has not started its extended quote yet,
  // and `last` is still the regular close. Across 17 days of live samples it
  // equalled the official close in 12 of 13 such reads (the 13th, at 16:00:01,
  // was 2 cents into the closing auction) while CNBC showed after-hours trades
  // already printing. Deferring instead left cards on a mid-afternoon price —
  // INTC 2% off. Anything else unreadable is still refused.
  const noChangeYet = p.netChange == null || String(p.netChange).trim() === '';
  if (net == null && !noChangeYet) return null;     // unreadable: keep what is cached
  const close = noChangeYet ? last : round4(last - net);
  const prev = typeof prevCloseHint === 'number' && prevCloseHint > 0 ? prevCloseHint : null;
  // In the first minutes of pre-market (seen on a Monday at 4:02am) Nasdaq has
  // not yet rolled its reference forward, so `last - net` recovers the session
  // BEFORE the last one: exactly the previous close. When that happens while the
  // card already holds a different, later close, the payload is the stale one.
  // A stock that genuinely closed unchanged has price == previous close too,
  // so it is not affected.
  const held = typeof priceHint === 'number' && priceHint > 0 ? priceHint : null;
  // Pre-market only: after the bell `last - net` was exact in every populated
  // sample from 16:10 on, and applying this there would refuse a real close on
  // the rare day a stock finishes exactly unchanged from an intraday price.
  if (guardRollover && prev != null && held != null
    && Math.abs(close - prev) < 0.005 && Math.abs(held - prev) >= 0.005) return null;
  // A "close" nowhere near the previous one means these fields are not what we
  // think they are. Keep the cached quote rather than publish a wrong number.
  if (prev != null && Math.abs(close - prev) / prev > 0.4) return null;
  return {
    price: close,
    changePct: prev == null ? null : Math.round(((close - prev) / prev) * 1e4) / 100,
    prevClose: prev,
    // already measured against `close`; absent until Nasdaq starts the extended quote
    ...(noChangeYet ? {} : { ext: { price: last, changePct: pct } }),
  };
}

export async function getQuotes(symbols, _apiKey, { signal, classOf = {}, phase, prevCloseOf = {}, priceOf = {}, onMeta, onError, onDeferred } = {}) {
  const out = {};
  let blocked = false;
  await mapLimit(symbols, QUOTE_CONCURRENCY, async (sym) => {
    const order = classOf[sym] === 'etf' ? ['etf', 'stocks'] : ['stocks', 'etf'];
    let sawError = false;
    for (const cls of order) {
      try {
        const res = await gatedFetch(
          `https://api.nasdaq.com/api/quote/${encodeURIComponent(sym)}/info?assetclass=${cls}`,
          { signal, headers: { Accept: 'application/json' } },
        );
        if (!res.ok) { sawError = true; continue; }
        const d = (await res.json())?.data;
        if (!d?.primaryData) continue;           // "Symbol not exists" for this class
        const frame = quoteFrame(d.marketStatus, phase);
        const status = String(d.marketStatus || '');
        const preMarket = /pre/i.test(status) || (!/open|after|extended/i.test(status) && phase === 'pre');
        const q = readQuote(d, { extended: frame === 'extended', prevCloseHint: prevCloseOf[sym],
          priceHint: priceOf[sym], guardRollover: preMarket });
        // Readable payload we cannot turn into an honest quote: leave the symbol
        // out so the caller keeps what it had. NOT an error — reporting one here
        // would mark a perfectly real ticker "Not a ticker" — but the caller is
        // told, so it neither calls the data stale nor treats it as fresh.
        if (!q) { onDeferred?.(sym); return; }
        out[sym] = q;
        onMeta?.(sym, {
          name: typeof d.companyName === 'string' ? d.companyName : null,
          exchange: typeof d.exchange === 'string' ? d.exchange : null,
          cls,
        });
        return;
      } catch (err) {
        if (err?.code === 'blocked') blocked = true;
        sawError = true;                        // network/parse: retry next cycle
      }
    }
    onError?.(sym, blocked ? 'blocked' : sawError ? 'network' : 'no-data');
  });
  return out;
}

/* --------------------------------------------------------- extended hours */

/**
 * Pre-market / after-hours prices.
 *
 * CRITICAL: Nasdaq's own percentage on this endpoint is measured against the
 * PREVIOUS day's close, not today's regular close, so it is the cumulative
 * two-session move rather than the extended-hours move. Verified: NVDA showed
 * +1.25% there while the actual after-hours move was -0.23% — the opposite
 * sign. The delta is therefore recomputed against today's regular close, which
 * the caller supplies via `closeOf`.
 *
 *   -> { AAPL: { price: 316.9961, changePct: 0.05 } }
 */
export async function getExtended(symbols, _apiKey, { phase, closeOf = {}, classOf = {}, signal } = {}) {
  const markettype = phase === 'pre' ? 'pre' : 'post';
  const out = {};
  await mapLimit(symbols, QUOTE_CONCURRENCY, async (sym) => {
    const close = closeOf[sym];
    if (typeof close !== 'number' || close <= 0) return;   // nothing to measure against
    const cls = classOf[sym] === 'etf' ? 'etf' : 'stocks';
    try {
      const res = await gatedFetch(
        `https://api.nasdaq.com/api/quote/${encodeURIComponent(sym)}/extended-trading`
        + `?assetclass=${cls}&markettype=${markettype}`,
        { signal, headers: { Accept: 'application/json' } },
      );
      if (!res.ok) return;
      const rows = (await res.json())?.data?.infoTable?.rows;
      const consolidated = Array.isArray(rows) && rows[0] ? rows[0].consolidated : null;
      if (typeof consolidated !== 'string') return;
      const price = parseNum((consolidated.match(/\$[\d,.]+/) || [])[0]);
      if (price == null || price <= 0) return;
      out[sym] = {
        price,
        changePct: Math.round(((price - close) / close) * 10000) / 100,
      };
    } catch { /* extended data is a bonus; never let it fail a refresh */ }
  });
  return out;
}

/**
 * Confirms a ticker actually exists. Unknown symbols answer HTTP 200 with
 * `data: null`, so the body must be inspected.
 * @returns 'ok' | 'unknown' | 'error'
 */
export async function verifySymbol(sym, _apiKey, { signal } = {}) {
  let sawError = false;
  for (const cls of ['stocks', 'etf']) {
    try {
      const res = await gatedFetch(
        `https://api.nasdaq.com/api/quote/${encodeURIComponent(sym)}/info?assetclass=${cls}`,
        { signal, priority: true, headers: { Accept: 'application/json' } },
      );
      if (!res.ok) { sawError = true; continue; }
      const d = (await res.json())?.data;
      if (d?.primaryData?.lastSalePrice) return 'ok';
    } catch { sawError = true; }
  }
  return sawError ? 'error' : 'unknown';
}

/* ------------------------------------------------------------------ series */

const SERIES_POINTS = 40;   // enough shape for a 150px sparkline, small in storage
const SERIES_CONCURRENCY = 3;

/** Evenly sample `n` values across the array, always keeping first and last. */
function downsample(values, n) {
  if (values.length <= n) return values;
  const out = new Array(n);
  const step = (values.length - 1) / (n - 1);
  for (let i = 0; i < n; i++) out[i] = values[Math.round(i * step)];
  return out;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
  }));
  return out;
}

/**
 * Intraday price path per symbol, for the sparkline only.
 *   -> { AAPL: { points: [231.1, ...], name, exchange } }
 * Nasdaq's own percentageChange disagrees with the quote provider's at times,
 * so nothing here is used for the displayed price or change — shape only.
 */
export async function getSeries(symbols, _apiKey, { signal, classOf = {} } = {}) {
  const out = {};
  await mapLimit(symbols, SERIES_CONCURRENCY, async (sym) => {
    // Nasdaq only serves ETF charts under assetclass=etf; asking for "stocks"
    // returns null, so SPY, QQQ, VOO and every other ETF card went without a
    // sparkline forever. The quote pass has usually learned the class already;
    // when it hasn't, fall back to the other class rather than giving up.
    const known = classOf[sym];
    const order = known === 'etf' ? ['etf'] : known === 'stocks' ? ['stocks'] : ['stocks', 'etf'];
    for (const cls of order) {
      try {
        const res = await gatedFetch(
          `https://api.nasdaq.com/api/quote/${encodeURIComponent(sym)}/chart?assetclass=${cls}`,
          { signal, headers: { Accept: 'application/json' } },
        );
        if (!res.ok) continue;
        const d = (await res.json())?.data;
        const chart = Array.isArray(d?.chart) ? d.chart : [];
        const ys = chart.map((p) => p?.y).filter((y) => typeof y === 'number' && Number.isFinite(y));
        if (ys.length < 2) continue;
        out[sym] = {
          points: downsample(ys, SERIES_POINTS).map((v) => Math.round(v * 100) / 100),
          name: typeof d.company === 'string' ? d.company : null,
          exchange: typeof d.exchange === 'string' ? d.exchange : null,
        };
        return;
      } catch { /* sparkline is decoration; failures are silent */ }
    }
  });
  return out;
}

/* ----------------------------------------------------------- earnings results */

/**
 * The most recently reported quarter: consensus vs actual.
 *
 * CRITICAL: this endpoint also returns `UpcomingQuarter` rows whose `earnings`
 * is a literal 0.0 placeholder. Treating those as an actual result reports a
 * -100% surprise on every stock, so only `PreviousQuarter` rows are considered.
 *
 *   -> { AAPL: { period, consensus, actual, surprisePct } }
 */
export async function getEarningsResults(symbols, _apiKey, { signal } = {}) {
  const out = {};
  await mapLimit(symbols, QUOTE_CONCURRENCY, async (sym) => {
    try {
      const res = await gatedFetch(`https://api.nasdaq.com/api/quote/${encodeURIComponent(sym)}/eps`,
        { signal, headers: { Accept: 'application/json' } });
      if (!res.ok) return;
      const rows = (await res.json())?.data?.earningsPerShare;
      if (!Array.isArray(rows)) return;
      const past = rows.filter((r) => r?.type === 'PreviousQuarter'
        && typeof r.consensus === 'number' && typeof r.earnings === 'number');
      const last = past[past.length - 1];
      if (!last || !last.consensus) return;      // a zero consensus has no meaningful surprise
      out[sym] = {
        period: typeof last.period === 'string' ? last.period : null,
        consensus: last.consensus,
        actual: last.earnings,
        surprisePct: Math.round(((last.earnings - last.consensus) / Math.abs(last.consensus)) * 1000) / 10,
      };
    } catch { /* results are a bonus; never fail a refresh over them */ }
  });
  return out;
}

/* ---------------------------------------------------------- insider buying */

/**
 * Notable open-market insider purchases.
 *
 * Almost all insider activity is mechanical and meaningless: across 30 tickers
 * the observed mix was 295 RSU vestings, 270 dispositions, 155 option
 * exercises, 224 sells — and only 38 genuine `Buy` rows. `Automatic Buy` is a
 * scheduled plan and carries no price, so it is excluded too. Only a `Buy`
 * with a real price is considered.
 *
 * "Notable" then has to work for a $3T company and a $200M one alike, so it is
 * deliberately two-sided rather than a single dollar cutoff:
 *
 *   - BIG_VALUE      a large absolute commitment, meaningful at any size
 *   - STAKE_PCT      or a large increase in the insider's OWN exposure, which
 *                    scales naturally with company size, floored by
 *                    STAKE_FLOOR so token buys can't qualify on percentage
 *
 * A brand-new position counts as a large increase by definition.
 */
const INSIDER_BIG_VALUE = 500000;
const INSIDER_STAKE_PCT = 25;
const INSIDER_STAKE_FLOOR = 50000;
const INSIDER_WINDOW_DAYS = 30;
const INSIDER_PER_SYMBOL = 3;

/** "BOURLA ALBERT" -> "Bourla Albert" */
export function titleCase(v) {
  return String(v || '').toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).trim();
}

/** m/d/yyyy -> days since, or null */
function daysAgo(v, now) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(v || '').trim());
  if (!m) return null;
  const then = Date.UTC(+m[3], +m[1] - 1, +m[2]);
  return Math.floor((now - then) / 86400000);
}

/** Exported for testing: is one parsed row worth showing? */
export function isNotableBuy({ value, stakePct, isNew }) {
  if (!(value > 0)) return false;
  if (value >= INSIDER_BIG_VALUE) return true;
  const bigStake = isNew || (stakePct != null && stakePct >= INSIDER_STAKE_PCT);
  return bigStake && value >= INSIDER_STAKE_FLOOR;
}

/**
 * -> { PFE: [{ who, role, date, days, shares, price, value, stakePct, isNew }] }
 * Symbols with nothing notable are simply absent.
 */
export async function getInsiderBuys(symbols, _apiKey, { signal, now = Date.now() } = {}) {
  const out = {};
  await mapLimit(symbols, QUOTE_CONCURRENCY, async (sym) => {
    try {
      const res = await gatedFetch(
        `https://api.nasdaq.com/api/company/${encodeURIComponent(sym)}/insider-trades?limit=40&type=ALL`,
        { signal, headers: { Accept: 'application/json' } },
      );
      if (!res.ok) return;
      const rows = (await res.json())?.data?.transactionTable?.table?.rows;
      if (!Array.isArray(rows)) return;

      const hits = [];
      for (const r of rows) {
        if ((r?.transactionType || '').trim() !== 'Buy') continue;   // excludes Automatic Buy
        const days = daysAgo(r.lastDate, now);
        if (days == null || days < 0 || days > INSIDER_WINDOW_DAYS) continue;
        const shares = parseNum(r.sharesTraded);
        const price = parseNum(r.lastPrice);
        const held = parseNum(r.sharesHeld);
        if (!shares || !price || price <= 0) continue;               // no price -> can't judge
        const value = shares * price;
        const prior = held == null ? null : held - shares;
        const isNew = prior != null && prior <= 0;
        const stakePct = prior != null && prior > 0
          ? Math.round((shares / prior) * 1000) / 10 : null;
        if (!isNotableBuy({ value, stakePct, isNew })) continue;
        hits.push({
          who: titleCase(r.insider), role: typeof r.relation === 'string' ? r.relation : null,
          date: r.lastDate, days, shares, price,
          value: Math.round(value), stakePct, isNew,
        });
      }
      hits.sort((a, b) => b.value - a.value);
      // [] means "read cleanly, nothing notable". A symbol whose read failed is
      // OMITTED below, so the caller keeps what it already had rather than
      // making the section vanish.
      out[sym] = hits.slice(0, INSIDER_PER_SYMBOL);
    } catch { /* omit: unread, not "nothing" */ }
  });
  return out;
}

/* ------------------------------------------------------------------ search */

/** Nasdaq exchange codes -> the venue slug Google Finance expects. */
export function googleExchange(ex) {
  if (!ex) return null;
  const e = String(ex).toUpperCase().trim();
  if (e.startsWith('NASDAQ') || ['NGS', 'NGM', 'NMS', 'NCM', 'NASD'].includes(e)) return 'NASDAQ';
  if (e === 'NYSE' || e === 'N') return 'NYSE';
  if (e === 'AMEX' || e === 'A' || e.includes('AMERICAN')) return 'NYSEAMERICAN';
  // Cboe BZX (still "BATS" at both Nasdaq and Google) is its own venue. Folding
  // it into NYSEARCA sent every card for ARKK, ARKG, FBTC and the like to
  // Google Finance's not-found page — checked link by link.
  if (e === 'BAT' || e.includes('BATS') || e.includes('CBOE')) return 'BATS';
  // PSE is the old Pacific/Arca code Nasdaq still returns for many ETFs.
  if (e === 'PSE' || e === 'ARCA' || e.includes('ARCA')) return 'NYSEARCA';
  return null;
}

/**
 * Company-or-ticker search. Needs no API key, so autocomplete works before the
 * user has pasted one.  -> [{ symbol, name, exchange, kind }]
 */
export async function searchSymbols(query, _apiKey, { signal } = {}) {
  const q = String(query || '').trim();
  if (q.length < 1) return [];
  const res = await gatedFetch(
    `https://api.nasdaq.com/api/autocomplete/slookup/10?search=${encodeURIComponent(q)}`,
    { signal, priority: true, headers: { Accept: 'application/json' } },
  );
  if (!res.ok) return [];
  const rows = (await res.json())?.data;
  if (!Array.isArray(rows)) return [];

  const up = q.toUpperCase();
  return rows
    .filter((r) => r?.symbol && r?.name)
    .filter((r) => {
      const asset = String(r.asset || '').toUpperCase();
      return asset === 'STOCKS' || asset === 'ETF';
    })
    // Structured products leak into this endpoint; they never have a clean ticker.
    .filter((r) => /^[A-Z][A-Z0-9.\-]{0,6}$/.test(String(r.symbol).toUpperCase()))
    .map((r) => ({
      symbol: String(r.symbol).toUpperCase(),
      name: String(r.name).replace(/\s+(Common Stock|Class [A-Z] .*|Common Shares).*$/i, '').trim(),
      exchange: r.exchange || null,
      kind: String(r.asset || '').toUpperCase() === 'ETF' ? 'ETF' : null,
    }))
    // Ordinary shares outrank ETFs: someone typing "tesl" wants Tesla, not a
    // leveraged TSLA product whose ticker happens to match the letters exactly.
    .sort((a, b) => {
      const etf = (x) => (x.kind === 'ETF' ? 1 : 0);
      const rank = (x) => (x.symbol === up ? 0
        : x.name.toUpperCase().startsWith(up) ? 1
          : x.symbol.startsWith(up) ? 2 : 3);
      return etf(a) - etf(b) || rank(a) - rank(b) || a.symbol.localeCompare(b.symbol);
    })
    .slice(0, 7);
}
