/**
 * Service worker: alarms in, chrome.storage.local out. Never touches the DOM,
 * never learns which provider is behind the interface.
 */

import { provider } from './providers/index.js';
import { getState, patch, migrate } from './store.js';
import * as sync from './sync.js';
import { resetBreakers, breakerStatus } from './net.js';
import { isRegularHours, marketPhase, lastSettledCloseAt } from './market-hours.js';

/**
 * Bumped on every change to worker logic. Page assets reload with each new tab,
 * but the service worker only updates when the extension is reloaded — so a
 * stale worker paired with fresh UI is easy to mistake for a data bug.
 * `diag.build` makes that state visible instead of guessable.
 */
const BUILD = '1.6.3';

const QUOTES_ALARM = 'refresh-quotes';
const CATALYSTS_ALARM = 'refresh-catalysts';
const SERIES_ALARM = 'refresh-series';

const QUOTES_PERIOD_MIN = 15;
const CATALYSTS_PERIOD_MIN = 60 * 24;
const SERIES_PERIOD_MIN = 30;   // sparklines are decoration; half the quote cadence

const QUOTES_MIN_GAP_MS = 60 * 1000;            // floor against force-refresh spam
const CATALYSTS_MIN_GAP_MS = 23 * 60 * 60 * 1000; // "at most once a day"
/**
 * How soon a symbol the source could not resolve is looked up again. Without
 * this, a ticker with no published date stayed "unchecked" until the next
 * allowed scan (up to 6h) and every new tab re-queried the whole watchlist for
 * it — 25+ requests a minute for someone who opens tabs all day, at the host
 * that soft-blocks bursts.
 */
const CATALYSTS_RETRY_MS = 60 * 60 * 1000;
/**
 * The day-by-day calendar scan gets its own floor, and `force` does NOT lift it.
 * Every other floor is about freshness; this one is about load. A forced
 * refresh happens on every ticker add, and letting that trigger a ~45-request
 * scan meant adding a handful of tickers fired hundreds of requests at one
 * bot-protected host in a couple of minutes — which is exactly how the browser
 * gets soft-blocked. Only an explicit user refresh may override it.
 */
const CATALYSTS_SCAN_MIN_GAP_MS = 6 * 60 * 60 * 1000;
const SERIES_MIN_GAP_MS = 5 * 60 * 1000;
const RESULTS_MIN_GAP_MS = 30 * 60 * 1000;
const STALE_FETCH_MS = 45 * 1000;   // longer than the UI's pending window
const INSIDERS_MIN_GAP_MS = 12 * 60 * 60 * 1000;  // Form 4s trickle in; twice a day is plenty
export const REPORTED_DAYS = 4;   // how long a reported quarter stays on screen

/** Service workers get torn down, so this only guards a single wake cycle. */
const inflight = { quotes: null, catalysts: null, series: null, logos: null, results: null, insiders: null };

function ensureAlarms() {
  chrome.alarms.create(QUOTES_ALARM, { periodInMinutes: QUOTES_PERIOD_MIN, delayInMinutes: 1 });
  chrome.alarms.create(CATALYSTS_ALARM, { periodInMinutes: CATALYSTS_PERIOD_MIN, delayInMinutes: 1 });
  chrome.alarms.create(SERIES_ALARM, { periodInMinutes: SERIES_PERIOD_MIN, delayInMinutes: 1 });
}

/**
 * Records why a refresh did what it did. Never contains the API key.
 *
 * Serialized through a promise chain and kept in memory: catalysts and series
 * refresh in parallel, and a plain read-modify-write let them clobber each
 * other's entries — the exact class of race as the inflight bug.
 */
let diagState = null;
let diagChain = Promise.resolve();
function writeDiag(entry) {
  diagChain = diagChain.then(async () => {
    try {
      if (!diagState) {
        const { diag } = await chrome.storage.local.get('diag');
        diagState = diag || {};
      }
      diagState = { ...diagState, build: BUILD, ...entry };
      await chrome.storage.local.set({ diag: diagState });
    } catch { /* diagnostics must never break a refresh */ }
  });
  return diagChain;
}

/**
 * Serialized read-modify-write for `meta`.
 *
 * Three refreshers enrich meta concurrently: quotes learn name/exchange/asset
 * class, series backfills labels, logos add the image. Each used to copy a
 * snapshot and write the whole object back, so whichever finished last silently
 * discarded the others' fields — which is why logos appeared and then reverted
 * to monograms. Re-reading inside a promise chain makes the merges commutative.
 */
let metaChain = Promise.resolve();
function mergeMeta(updater) {
  metaChain = metaChain.then(async () => {
    const got = await chrome.storage.local.get('meta');
    const current = got?.meta || {};
    const next = updater({ ...current });
    if (next && JSON.stringify(next) !== JSON.stringify(current)) {
      await chrome.storage.local.set({ meta: next });
    }
  }).catch(() => { /* meta enrichment must never break a refresh */ });
  return metaChain;
}

async function refreshQuotes({ force = false, gapOnly = false, only = null } = {}) {
  // A passive refresh already running must not absorb a forced one: the passive
  // pass may decide to skip (market closed), silently discarding the force.
  if (inflight.quotes) {
    if (!force) return inflight.quotes;
    try { await inflight.quotes; } catch { /* run the forced pass regardless */ }
  }
  const run = (async () => {
    const st = await getState();
    // A worker torn down mid-refresh leaves fetchingSince set. Clear a stale one
    // up front so the UI can never be stranded on "Fetching…".
    if (st.quotes.fetchingSince && Date.now() - st.quotes.fetchingSince > STALE_FETCH_MS) {
      await patch({ quotes: { ...st.quotes, fetchingSince: 0 } });
      st.quotes = { ...st.quotes, fetchingSince: 0 };
    }
    if (!st.symbols.length) {                    // a key is optional now, symbols are not
      await patch({ quotes: { ...st.quotes, fetchingSince: 0 } });
      await writeDiag({ quotes: { at: Date.now(), skipped: 'no-symbols' } });
      return;
    }
    // The alarm still fires outside market hours; it just returns before the
    // network. The one exception is a first run with nothing cached at all —
    // otherwise installing in the evening shows skeletons until the next open.
    // Outside market hours we normally skip the network entirely. The exception
    // is a gap in what we're tracking: never fetched, or a symbol with no quote
    // yet. Without it, a ticker added in the evening shows nothing until 9:30am.
    const incomplete = st.quotes.fetchedAt === 0 || st.symbols.some((s2) => !st.quotes.data[s2]);
    const phase = marketPhase();
    const showExt = st.settings.showExtended !== false;
    const extendedSession = (phase === 'pre' || phase === 'after') && showExt;
    if (!force && Date.now() - st.quotes.fetchedAt < QUOTES_MIN_GAP_MS) {
      await writeDiag({ quotes: { at: Date.now(), skipped: 'rate-floor' } });
      return;
    }

    // Who to fetch.
    //
    // 1.6.1 skipped quotes entirely outside the regular session, reasoning that
    // the close is frozen. It is — but our last fetch was up to 15 minutes
    // BEFORE the bell, so nothing ever captured the official close: every card
    // showed a mid-afternoon price as "today's close" all evening and through the
    // next pre-market, and the after-hours line was measured against it.
    //
    // Now a card is refetched until it has been read after the most recent close
    // settled. During the regular session everything is live; during pre-market
    // and after-hours with the extended line on, everything is fetched because
    // that one request also carries the extended trade (so it replaces the
    // dedicated extended-hours call rather than adding to it).
    const missing = st.symbols.filter((s2) => !st.quotes.data[s2]);
    const narrowed = only && st.symbols.includes(only) ? [only] : missing;
    const settledAt = lastSettledCloseAt();
    const needsClose = st.symbols.filter((s2) => !(st.quotes.data[s2]?.at >= settledAt));
    const targets = force || incomplete ? (gapOnly ? narrowed : st.symbols)
      : phase === 'open' || extendedSession ? st.symbols
        : needsClose;
    if (!targets.length) {
      await patch({ quotes: { ...st.quotes, fetchingSince: 0 } });
      await writeDiag({ quotes: { at: Date.now(), skipped: phase === 'open' ? 'nothing-missing' : 'close-settled' } });
      return;
    }
    const errors = {};
    const deferred = new Set();       // answered, but not yet usable (e.g. no change field)
    // Only claim a fetch is running when one actually is; an extended-only pass
    // must not put cards into a pending state they never leave.
    if (targets.length) await patch({ quotes: { ...st.quotes, fetchingSince: Date.now() } });
    try {
      // classOf saves a request per ETF: Nasdaq only serves them under
      // assetclass=etf, so remember which class worked.
      const classOf = {};
      for (const [k, v] of Object.entries(st.meta)) if (v?.cls) classOf[k] = v.cls;
      const learned = {};
      const fresh = targets.length
        ? await provider.getQuotes(targets, st.settings.apiKey, {
          classOf,
          // The session decides how the payload must be read, and the previous
          // close cannot be changed by extended trading — so the stored one is
          // the correct reference for the day's move.
          phase,
          prevCloseOf: Object.fromEntries(Object.entries(st.quotes.data || {})
            .filter(([, v]) => typeof v?.prevClose === 'number')
            .map(([k, v]) => [k, v.prevClose])),
          priceOf: Object.fromEntries(Object.entries(st.quotes.data || {})
            .filter(([, v]) => typeof v?.price === 'number')
            .map(([k, v]) => [k, v.price])),
          onMeta: (sym, info) => { learned[sym] = info; },
          onError: (sym, why) => { errors[sym] = why; },
          onDeferred: (sym) => { deferred.add(sym); },
        })
        : {};
      // The extended line is shown only outside the regular session and only if
      // the user wants it; a quote never carries one otherwise.
      const keepExt = showExt && phase !== 'open';
      const now = Date.now();
      const data = {};
      for (const s of st.symbols) {
        if (fresh[s]) {
          const { ext, ...q } = fresh[s];
          data[s] = { ...q, at: now, ...(keepExt && ext ? { ext } : {}) };
        } else if (st.quotes.data[s]) {
          const { ext, ...q } = st.quotes.data[s];          // keep last known
          data[s] = keepExt && ext ? { ...q, ext } : q;
        }
      }
      const got = Object.keys(fresh).length;
      // A symbol that answered "no data" isn't a failure — don't call it stale.
      const hardFailures = Object.entries(errors).filter(([, w]) => w !== 'no-data');
      // Definitively-unknown symbols (a company name typed as a ticker, a
      // delisting) must be distinguishable from a transient outage, or the card
      // says "No data" forever with no way to know why.
      const unknown = { ...(st.quotes.unknown || {}) };
      for (const s2 of st.symbols) {
        if (fresh[s2]) delete unknown[s2];
        else if (errors[s2] === 'no-data') unknown[s2] = true;
      }
      for (const k of Object.keys(unknown)) if (!st.symbols.includes(k)) delete unknown[k];
      await patch({
        quotes: {
          // A partial pass speaks only for what it asked about. A gap fill
          // covers one ticker; an extended-only pass fetched no quotes at all.
          // Neither may restamp global freshness (that would suppress the next
          // real refresh) nor call everything stale on their own evidence.
          // A gap fill speaks only for one ticker. A pass whose answers were all
          // deferred (Nasdaq returned no change field yet) reached the source
          // fine: it is neither fresh data nor an outage, so it changes neither.
          fetchedAt: gapOnly || !got ? st.quotes.fetchedAt : Date.now(),
          fetchingSince: 0,
          unknown,
          stale: gapOnly || (!got && deferred.size) ? st.quotes.stale : (got === 0 && st.symbols.length > 0),
          reason: gapOnly || (!got && deferred.size) ? st.quotes.reason : (got === 0
            ? (hardFailures.some(([, w]) => w === 'blocked') ? 'blocked'
              : hardFailures[0]?.[1] || 'offline')
            : null),
          data,
        },
      });
      // the quote response carries company name / exchange / asset class for free
      if (Object.keys(learned).length) {
        await mergeMeta((meta) => {
          for (const [sym, info] of Object.entries(learned)) {
            const cur = meta[sym] || {};
            meta[sym] = {
              ...cur,                                   // never drop a stored logo
              name: cur.name || info.name || null,
              exchange: cur.exchange || provider.googleExchange(info.exchange) || null,
              cls: info.cls || cur.cls || null,
            };
          }
          return meta;
        });
      }
      // Extended-hours line. The quote request above already carries the
      // extended trade, measured against the close; the dedicated call is now
      // only a fallback for cards it could not supply (a deferred answer).
      let extPhase = keepExt && Object.values(data).some((r) => r.ext) ? (phase === 'pre' ? 'pre' : 'after') : null;
      const lacking = extendedSession ? targets.filter((s2) => data[s2]?.price != null && !fresh[s2]?.ext) : [];
      if (lacking.length) {
        const closeOf = Object.fromEntries(lacking.map((s2) => [s2, data[s2].price]));
        try {
          const ext = await provider.getExtended(lacking, st.settings.apiKey, { phase, closeOf, classOf });
          for (const [sym, e] of Object.entries(ext)) if (data[sym]) data[sym] = { ...data[sym], ext: e };
          if (Object.keys(ext).length) extPhase = phase;
        } catch { /* decoration only */ }
      }
      await patch({ quotes: { ...(await getState()).quotes, extPhase, data } });
      const backoff = breakerStatus();
      await writeDiag({
        quotes: { at: Date.now(), asked: targets.length, got, deferred: deferred.size || undefined, errors, extPhase },
        ...(Object.keys(backoff).length ? { backoff } : {}),
      });
      if (hardFailures.length) console.warn('[catalyst] quote failures', errors);
    } catch (err) {
      // Cached data stays on screen; the footer says why it's not fresh.
      const why = err?.code || provider.describeError?.(err) || 'offline';
      await patch({ quotes: { ...st.quotes, fetchingSince: 0, stale: true, reason: err?.code || 'offline' } });
      await writeDiag({ quotes: { at: Date.now(), asked: st.symbols.length, got: 0, threw: why, errors } });
      console.warn('[catalyst] quote refresh threw:', why, errors);
    }
  })();
  inflight.quotes = run;
  run.finally(() => { if (inflight.quotes === run) inflight.quotes = null; });
  return run;
}

async function refreshCatalysts({ force = false, userAsked = false, gapOnly = false, only = null } = {}) {
  // A passive refresh already running must not absorb a forced one: the passive
  // pass may decide to skip (market closed), silently discarding the force.
  if (inflight.catalysts) {
    if (!force) return inflight.catalysts;
    try { await inflight.catalysts; } catch { /* run the forced pass regardless */ }
  }
  const run = (async () => {
    const st = await getState();
    if (!st.symbols.length) {
      await writeDiag({ catalysts: { at: Date.now(), skipped: 'no-symbols' } });
      return;
    }
    // A symbol absent from `data` is unresolved: never answered for. One with an
    // empty array HAS been checked and has nothing scheduled — without that
    // distinction a new ticker waits up to 23h for its earnings date.
    const now = Date.now();
    const tried = { ...(st.catalysts.tried || {}) };
    for (const k of Object.keys(tried)) if (!st.symbols.includes(k)) delete tried[k];
    const unresolved = st.symbols.filter((s2) => !(s2 in st.catalysts.data));
    const due = unresolved.filter((s2) => !tried[s2] || now - tried[s2] >= CATALYSTS_RETRY_MS);
    const dailyDue = now - st.catalysts.fetchedAt >= CATALYSTS_MIN_GAP_MS;
    if (!force && !dailyDue && !due.length) {
      await writeDiag({ catalysts: { at: now, skipped: unresolved.length ? 'awaiting-retry' : 'fresh-enough' } });
      return;
    }

    const scanGap = now - (st.catalysts.scannedAt || 0);
    const allowScan = userAsked || scanGap >= CATALYSTS_SCAN_MIN_GAP_MS;

    // Who this pass is for. A full pass (daily, or someone asked) covers everyone;
    // an add covers the new ticker; a gap fill covers only what is due — unless
    // the scan is allowed, which costs the same for one symbol as for all of
    // them, so every unresolved symbol rides along.
    const cTargets = (force && !gapOnly) || userAsked || dailyDue ? st.symbols
      : gapOnly && only && st.symbols.includes(only) ? [only]
        : allowScan ? unresolved : due;
    const fullPass = cTargets.length === st.symbols.length;

    try {
      const fresh = await provider.getCatalysts(cTargets, st.settings.apiKey, { allowScan });
      const today = Math.floor(Date.now() / 86400000);
      const dayOf = (iso) => { const p2 = String(iso).split('-'); return Math.floor(Date.UTC(+p2[0], +p2[1] - 1, +p2[2]) / 86400000); };
      const data = {};
      for (const s of st.symbols) {
        const rows = fresh[s];
        const cached = st.catalysts.data[s];
        // An empty array marks the symbol as checked, and `unchecked` uses
        // absence from `data` to decide who still needs looking at. So a symbol
        // the provider did NOT answer for, and that we have nothing cached for,
        // must be left out entirely — recording [] would declare it checked and
        // it would never get an earnings date again.
        if (!Array.isArray(rows) && !cached) continue;
        let next = Array.isArray(rows) ? [...rows] : [...cached];
        // The calendar scan only looks forward, so carry a just-passed date
        // along for a few days; otherwise "just reported" could never be shown.
        for (const old of st.catalysts.data[s] || []) {
          const age = today - dayOf(old.date);
          if (age > 0 && age <= REPORTED_DAYS && !next.some((x) => x.date === old.date)) next.unshift(old);
        }
        data[s] = next;
      }
      const withEvents = Object.values(data).filter((r) => r.length).length;
      for (const s2 of cTargets) {
        if (Array.isArray(fresh[s2])) delete tried[s2];
        else tried[s2] = now;          // still unresolved: wait before asking again
      }
      // Only stamp scannedAt when a scan actually ran, so a cheap pass that
      // resolved everything cannot lock out a scan a new ticker will need.
      const ranScan = (provider.scanDays?.() || 0) > 0;
      await patch({
        catalysts: {
          // Only a pass that covered everyone may claim the whole calendar is
          // fresh. A partial pass restamping this would push the daily refresh
          // of confirmed dates back indefinitely.
          fetchedAt: fullPass ? Date.now() : st.catalysts.fetchedAt,
          stale: false, data, tried,
          scannedAt: ranScan ? Date.now() : (st.catalysts.scannedAt || 0),
        },
      });
      await writeDiag({
        catalysts: {
          at: Date.now(), asked: cTargets.length, full: fullPass, withEvents,
          scan: ranScan ? provider.scanDays() : 'skipped',
          unresolved: Object.keys(tried).length ? Object.keys(tried) : undefined,
        },
      });
    } catch (err) {
      const why = err?.code || provider.describeError?.(err) || 'offline';
      // A failed pass must also wait before retrying, or an outage turns every
      // new tab into another attempt.
      for (const s2 of cTargets) if (!(s2 in st.catalysts.data)) tried[s2] = now;
      await patch({ catalysts: { ...st.catalysts, tried, stale: true } });
      await writeDiag({ catalysts: { at: Date.now(), asked: st.symbols.length, threw: why } });
      console.warn('[catalyst] catalyst refresh threw:', why);
    }
  })();
  inflight.catalysts = run;
  run.finally(() => { if (inflight.catalysts === run) inflight.catalysts = null; });
  return run;
}

async function refreshSeries({ force = false, gapOnly = false, only = null } = {}) {
  // A passive refresh already running must not absorb a forced one: the passive
  // pass may decide to skip (market closed), silently discarding the force.
  if (inflight.series) {
    if (!force) return inflight.series;
    try { await inflight.series; } catch { /* run the forced pass regardless */ }
  }
  const run = (async () => {
    const st = await getState();
    if (!st.symbols.length) {
      await writeDiag({ series: { at: Date.now(), skipped: 'no-symbols' } });
      return;
    }
    const incomplete = st.series.fetchedAt === 0 || st.symbols.some((s2) => !st.series.data[s2]);
    if (!force && !incomplete && !isRegularHours()) {
      await writeDiag({ series: { at: Date.now(), skipped: 'market-closed' } });
      return;
    }
    if (!force && Date.now() - st.series.fetchedAt < SERIES_MIN_GAP_MS) {
      await writeDiag({ series: { at: Date.now(), skipped: 'rate-floor' } });
      return;
    }

    try {
      const sTargets = !gapOnly ? st.symbols
        : (only && st.symbols.includes(only) ? [only] : st.symbols.filter((s2) => !st.series.data[s2]));
      if (!sTargets.length) return;
      const classOf = {};
      for (const [k, v] of Object.entries(st.meta || {})) if (v?.cls) classOf[k] = v.cls;
      const fresh = await provider.getSeries(sTargets, st.settings.apiKey, { classOf });
      const data = {};
      const labels = {};
      for (const s of st.symbols) {
        const row = fresh[s];
        if (row?.points?.length) data[s] = row.points;
        else if (st.series.data[s]) data[s] = st.series.data[s];
        if (row && (row.name || row.exchange)) labels[s] = row;
      }
      // Backfill labels through the serialized merge so a concurrent logo write
      // cannot be clobbered by this one.
      if (Object.keys(labels).length) {
        await mergeMeta((meta) => {
          for (const [s, row] of Object.entries(labels)) {
            const cur = meta[s] || {};
            meta[s] = {
              ...cur,
              name: cur.name || row.name || null,
              exchange: cur.exchange || provider.googleExchange(row.exchange) || null,
            };
          }
          return meta;
        });
      }
      const got = Object.keys(fresh).length;
      await patch({
        series: { fetchedAt: got ? Date.now() : st.series.fetchedAt, stale: got === 0, data },
      });
      await writeDiag({ series: { at: Date.now(), asked: st.symbols.length, got } });
    } catch (err) {
      await patch({ series: { ...st.series, stale: true } });
      await writeDiag({ series: { at: Date.now(), threw: provider.describeError?.(err) || 'offline' } });
    }
  })();
  inflight.series = run;
  run.finally(() => { if (inflight.series === run) inflight.series = null; });
  return run;
}

/**
 * Company logos. Immutable, so each symbol is fetched exactly once — a symbol
 * whose meta already has a `logo` key (even a null one) is never re-requested.
 * No alarm: this runs with refreshAll and is a no-op once every symbol resolves.
 */
async function refreshLogos({ force = false, gapOnly = false, only = null } = {}) {
  if (inflight.logos) {
    if (!force) return inflight.logos;
    try { await inflight.logos; } catch { /* run the forced pass regardless */ }
  }
  const run = (async () => {
    const st = await getState();
    let need = st.symbols.filter((s2) => !(st.meta[s2] && 'logo' in st.meta[s2]));
    // On an add, only the new ticker can possibly need a logo. Without this,
    // every add retried every symbol whose logo lookup had previously failed.
    if (gapOnly && only) need = need.filter((s2) => s2 === only);
    if (!need.length) return;
    try {
      const got = await provider.getLogos(need);
      let resolved = 0;
      await mergeMeta((meta) => {
        for (const s2 of need) {
          if (!(s2 in got)) continue;       // transient failure -> leave unchecked
          meta[s2] = { ...(meta[s2] || {}), logo: got[s2] };
          resolved++;
        }
        return meta;
      });
      await writeDiag({ logos: { at: Date.now(), asked: need.length, resolved } });
    } catch (err) {
      await writeDiag({ logos: { at: Date.now(), threw: provider.describeError?.(err) || 'offline' } });
    }
  })();
  inflight.logos = run;
  run.finally(() => { if (inflight.logos === run) inflight.logos = null; });
  return run;
}

/**
 * Consensus-vs-actual for symbols whose earnings date has just passed. Only
 * those symbols are queried, so this is usually a no-op.
 */
async function refreshResults({ force = false, gapOnly = false, only = null } = {}) {
  if (inflight.results) {
    if (!force) return inflight.results;
    try { await inflight.results; } catch { /* run the forced pass regardless */ }
  }
  const run = (async () => {
    const st = await getState();
    const today = Math.floor(Date.now() / 86400000);
    const dayOf = (iso) => { const p2 = String(iso).split('-'); return Math.floor(Date.UTC(+p2[0], +p2[1] - 1, +p2[2]) / 86400000); };
    const due = st.symbols.filter((s2) => (st.catalysts.data[s2] || []).some((r) => {
      const age = today - dayOf(r.date);
      return age >= 0 && age <= REPORTED_DAYS;
    }));
    if (!due.length) {
      // nothing reported recently: drop any results we were still showing
      if (Object.keys(st.results.data).length) await patch({ results: { fetchedAt: Date.now(), data: {} } });
      return;
    }
    // A gap fill is not a reason to refetch reported results: they change at
    // most once a quarter, and `force` is set on every ticker add.
    if ((!force || gapOnly) && Date.now() - st.results.fetchedAt < RESULTS_MIN_GAP_MS) return;
    try {
      const fresh = await provider.getEarningsResults(due, st.settings.apiKey);
      const data = {};
      for (const s2 of due) {
        if (fresh[s2]) data[s2] = fresh[s2];
        else if (st.results.data[s2]) data[s2] = st.results.data[s2];   // unread, keep
      }
      await patch({ results: { fetchedAt: Date.now(), data } });
      await writeDiag({ results: { at: Date.now(), due: due.length, got: Object.keys(data).length } });
    } catch (err) {
      await writeDiag({ results: { at: Date.now(), threw: provider.describeError?.(err) || 'offline' } });
    }
  })();
  inflight.results = run;
  run.finally(() => { if (inflight.results === run) inflight.results = null; });
  return run;
}

/** Notable open-market insider purchases. Filings move slowly, so twice a day. */
async function refreshInsiders({ force = false, gapOnly = false, only = null } = {}) {
  if (inflight.insiders) {
    if (!force) return inflight.insiders;
    try { await inflight.insiders; } catch { /* run the forced pass regardless */ }
  }
  const run = (async () => {
    const st = await getState();
    if (!st.symbols.length || st.settings.showInsiders === false) return;
    const unchecked = st.symbols.some((s2) => !(s2 in (st.insiders.seen || {})));
    if (!force && !unchecked && Date.now() - st.insiders.fetchedAt < INSIDERS_MIN_GAP_MS) return;
    try {
      const iTargets = !gapOnly ? st.symbols
        : (only && st.symbols.includes(only) ? [only] : st.symbols.filter((s2) => !(s2 in (st.insiders.seen || {}))));
      if (!iTargets.length) return;
      const fresh = await provider.getInsiderBuys(iTargets, st.settings.apiKey);
      // Merge, never replace. A symbol present in `fresh` was read cleanly (an
      // empty array is a real answer); one that is absent failed to read, and
      // must keep whatever it had — otherwise a single network blip makes the
      // whole section disappear.
      const data = {};
      const seen = { ...(st.insiders.seen || {}) };
      for (const s2 of st.symbols) {
        if (Array.isArray(fresh[s2])) {
          if (fresh[s2].length) data[s2] = fresh[s2];
          seen[s2] = 1;
        } else if (st.insiders.data[s2]) {
          data[s2] = st.insiders.data[s2];
        }
      }
      for (const k of Object.keys(seen)) if (!st.symbols.includes(k)) delete seen[k];
      await patch({ insiders: { fetchedAt: Date.now(), seen, data } });
      await writeDiag({
        // `read` = symbols answered cleanly (an empty list counts), not symbols with buys.
        insiders: { at: Date.now(), asked: st.symbols.length, read: Object.keys(fresh).length },
      });
    } catch (err) {
      await writeDiag({ insiders: { at: Date.now(), threw: provider.describeError?.(err) || 'offline' } });
    }
  })();
  inflight.insiders = run;
  run.finally(() => { if (inflight.insiders === run) inflight.insiders = null; });
  return run;
}

async function refreshAll(opts) {
  // Sequenced, not parallel: quotes and catalysts both hit Finnhub, and firing
  // them together doubles the instantaneous burst against a 60/min budget.
  // Series goes to Nasdaq, so it can ride along with catalysts.
  await refreshQuotes(opts);
  await Promise.all([refreshCatalysts(opts), refreshSeries(opts), refreshLogos(opts), refreshInsiders(opts)]);
  await refreshResults(opts);   // depends on the catalyst dates above
}

/* ------------------------------------------------------------------- sync */

// Local prefs changes push out (debounced — sync has write quotas); remote
// changes pull in. Caches and the API key never travel.
let pushTimer = null;
const WATCHED = ['symbols', 'settings', 'meta'];

function schedulePush() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    const st = await getState();
    const result = await sync.push(st);
    if (result === 'pushed') await writeDiag({ sync: { at: Date.now(), pushed: st.symbols.length } });
    else if (result === 'too-large') await writeDiag({ sync: { at: Date.now(), skipped: 'too-large' } });
  }, 2000);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') {
    if (WATCHED.some((k) => k in changes)) schedulePush();
    return;
  }
  if (area === 'sync' && changes[sync.SYNC_KEY]) {
    sync.apply(changes[sync.SYNC_KEY].newValue).then(async (r) => {
      await writeDiag({ sync: { at: Date.now(), incoming: r } });
      // Another device changed the list or settings. Fetch what is now missing;
      // there is no reason to refetch every ticker this device already has.
      if (r === 'applied') refreshAll({ force: true, gapOnly: true });
    });
  }
});

async function bootstrapSync() {
  const remote = await sync.read();
  if (!remote) { await sync.push(await getState()); return; }
  const r = await sync.apply(remote);
  await writeDiag({ sync: { at: Date.now(), bootstrap: r } });
}

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarms();
  migrate().then(bootstrapSync).then(() => refreshAll());
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarms();
  migrate().then(bootstrapSync).then(() => refreshAll());
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === QUOTES_ALARM) refreshQuotes();
  else if (alarm.name === CATALYSTS_ALARM) refreshCatalysts();
  else if (alarm.name === SERIES_ALARM) refreshSeries();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'refresh') {
    // Force path: a ticker was just added, the key changed, or the user asked.
    //
    // Only a deliberate act clears the backoff. Adding a ticker is NOT one:
    // clearing it on every add meant the breaker could never engage while
    // someone built their watchlist, which is precisely when the request load
    // is highest and the host is most likely to start refusing us.
    const userAsked = msg.reason === 'user' || msg.reason === 'key';
    if (userAsked) resetBreakers();
    // Only an explicit 'add' is a gap fill. An unlabelled refresh keeps the old
    // meaning — fetch everything — because narrowing by default would silently
    // turn any caller that forgot the reason into a no-op whenever nothing
    // happened to be missing.
    const isAdd = msg.reason === 'add';
    // `only` names the ticker just added, so an add costs the same whether the
    // watchlist holds three symbols or twenty-five.
    const only = isAdd && typeof msg.symbol === 'string' ? msg.symbol : null;
    refreshAll({ force: true, userAsked, gapOnly: isAdd, only })
      .then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type === 'wake') {
    // A tab opened after the browser was closed for a while; top up if stale.
    // Must return true and respond late: work started after a synchronous
    // sendResponse isn't tracked, and Chrome may kill the worker mid-fetch.
    ensureAlarms();
    refreshAll().then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});
