/**
 * A single shared gate for every request this extension makes to one host.
 *
 * Each feature was individually polite — 3 or 4 concurrent requests — but they
 * refresh at the same time, so for six symbols one cycle fired ~72 requests at
 * api.nasdaq.com in a burst. Nasdaq drops connections under that, which
 * surfaced as blanket "network" failures: missing prices, an "unavailable"
 * search box, and an earnings scan that silently returned nothing.
 *
 * Concurrency here is global, not per-feature, so adding another data source
 * can never re-create that storm.
 */

/**
 * Concurrency is per-host, and deliberately low for the keyless endpoints.
 *
 * This is the fix for net::ERR_HTTP2_PROTOCOL_ERROR. Node and curl open a fresh
 * TCP connection per request over HTTP/1.1, so six "concurrent" requests look
 * like six ordinary clients and never tripped anything in testing. Chrome
 * speaks HTTP/2 and multiplexes all six onto ONE connection, so the host sees
 * six simultaneous streams from a single socket — which is precisely the
 * signature bot protection looks for. It answers by resetting the stream.
 *
 * Two streams with 150ms between starts reads as a person, not a scraper. A
 * full refresh is ~22 requests, so this costs about three seconds of
 * background time and nothing on the paint path, which never waits on network.
 */
const LANES = {
  'api.nasdaq.com': { max: 2, spacing: 150 },
};
const DEFAULT_LANE = { max: 6, spacing: 40 };
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 2;

/**
 * Every request is time-boxed. Without this a single hung connection holds a
 * queue slot forever; four of them deadlock the gate permanently, which reads
 * as a totally dead extension — no prices, no search, nothing — with no error
 * to show for it. A slot must always come back.
 */
const REQUEST_TIMEOUT_MS = 8000;

/**
 * Per-host circuit breaker.
 *
 * The keyless providers are undocumented endpoints behind bot protection. When
 * they decide a client is automated they don't answer 429 — they reset the
 * HTTP/2 stream, which surfaces as net::ERR_HTTP2_PROTOCOL_ERROR. Retrying then
 * makes things strictly worse: it deepens the block and floods the console.
 *
 * After enough consecutive network-level failures to one host, stop calling it
 * and fail fast instead, backing off 1m -> 5m -> 15m -> 30m. One success closes
 * the breaker immediately.
 */
const TRIP_AFTER = 4;
const BACKOFF_MS = [60e3, 5 * 60e3, 15 * 60e3, 30 * 60e3];
const hosts = new Map();          // host -> { fails, openUntil, level }

function hostOf(url) { try { return new URL(String(url)).host; } catch { return 'unknown'; } }

function hostState(h) {
  if (!hosts.has(h)) hosts.set(h, { fails: 0, openUntil: 0, level: 0 });
  return hosts.get(h);
}

export function isBlocked(host, now = Date.now()) {
  const st = hosts.get(host);
  return Boolean(st && st.openUntil > now);
}

function noteFailure(h) {
  const st = hostState(h);
  st.fails++;
  if (st.fails >= TRIP_AFTER) {
    st.openUntil = Date.now() + BACKOFF_MS[Math.min(st.level, BACKOFF_MS.length - 1)];
    st.level++;
    st.fails = 0;
  }
}

function noteSuccess(h) {
  const st = hostState(h);
  st.fails = 0;
  st.openUntil = 0;
  st.level = 0;                   // a clean response fully closes the breaker
}

/** Clears all breaker state. Exists for tests and for an explicit user retry. */
export function resetBreakers() { hosts.clear(); }

/**
 * Clears the pacing state of every host lane. Exists for tests: `lastStart` is
 * an absolute timestamp, so a suite that moves the clock backwards between
 * scenarios would otherwise leave the gate waiting hours before its next start.
 */
export function resetGate() { lanes.clear(); }

/** Diagnostic: which hosts are currently being backed off, and until when. */
export function breakerStatus(now = Date.now()) {
  const out = {};
  for (const [h, st] of hosts) if (st.openUntil > now) out[h] = Math.round((st.openUntil - now) / 1000);
  return out;
}

export class HostBlockedError extends Error { code = 'blocked'; }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const lanes = new Map();          // host -> { active, lastStart, queue }

function lane(h) {
  if (!lanes.has(h)) {
    const cfg = LANES[h] || DEFAULT_LANE;
    lanes.set(h, { active: 0, lastStart: 0, queue: [], ...cfg });
  }
  return lanes.get(h);
}

function pump(h) {
  const L = lane(h);
  while (L.active < L.max && L.queue.length) {
    const job = L.queue.shift();
    L.active++;
    const wait = Math.max(0, L.lastStart + L.spacing - Date.now());
    L.lastStart = Date.now() + wait;
    sleep(wait).then(job.run).then(job.resolve, job.reject).finally(() => {
      L.active--;
      pump(h);
    });
  }
}

/** Queued fetch. Same signature as fetch, plus transparent retry on 429/5xx. */
export function gatedFetch(url, opts = {}) {
  const host = hostOf(url);
  // `priority` is ours, for queue ordering. fetch() has an option of the same
  // name whose only legal values are high/low/auto, so passing ours through
  // would throw a TypeError and break the very call it was meant to speed up.
  const { priority, ...init } = opts;
  return new Promise((resolve, reject) => {
    const job = {
      resolve,
      reject,
      run: async () => {
        if (isBlocked(host)) throw new HostBlockedError(`${host} backing off`);
        let lastErr;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
          const relay = () => ctrl.abort();
          if (opts.signal) opts.signal.addEventListener('abort', relay, { once: true });
          try {
            const res = await fetch(url, { ...init, signal: ctrl.signal, priority: priority ? 'high' : 'auto' });
            noteSuccess(host);            // the host is answering; reopen the gate
            if (!RETRY_STATUSES.has(res.status) || attempt === MAX_RETRIES) return res;
            await sleep(300 * (attempt + 1));
          } catch (err) {
            lastErr = err;
            noteFailure(host);
            // The comment used to claim a reset stream failed fast; it did not.
            // ERR_HTTP2_PROTOCOL_ERROR surfaces as a plain TypeError, so it fell
            // through to the generic retry and every search keystroke became
            // three requests at a host that was already refusing us — visible in
            // the console as six failures for two queries.
            //
            // A network-level failure is either a blip or a block. Neither is
            // worth three attempts: one retry covers the blip, and the breaker
            // handles the block. Interactive work does not retry at all, because
            // a person is waiting and a second attempt just delays the fallback.
            const netRetries = priority ? 0 : 1;
            if (err?.name === 'AbortError' || attempt >= netRetries) throw err;
            await sleep(300 * (attempt + 1));
          } finally {
            clearTimeout(timer);
            if (opts.signal) opts.signal.removeEventListener('abort', relay);
          }
        }
        throw lastErr || new Error('unreachable');
      },
    };
    // A person typing in the search box must not wait behind a 22-request
    // background refresh; at two lanes that queue is several seconds long,
    // which is what made search look broken. Interactive work jumps it.
    if (opts.priority) lane(host).queue.unshift(job);
    else lane(host).queue.push(job);
    pump(host);
  });
}

/** Test/diagnostic hook. */
export const stats = () => {
  let active = 0, queued = 0;
  for (const L of lanes.values()) { active += L.active; queued += L.queue.length; }
  return { active, queued };
};
