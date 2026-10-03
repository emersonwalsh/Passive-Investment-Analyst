/**
 * Cross-device sync of the watchlist and display preferences.
 *
 * chrome.storage.sync needs no extra permission, but it has hard limits: 8KB
 * per item, 100KB total, and write quotas. So only small, user-authored state
 * travels — never caches, and never logos (a full set is ~32KB on its own).
 *
 * The API key is deliberately device-local. Syncing a credential across every
 * signed-in browser is a bigger promise than this extension should make.
 *
 * Conflicts are last-write-wins on an explicit timestamp. Loops are prevented
 * by content comparison: an incoming payload that already matches local state
 * is dropped rather than re-applied.
 */

import { getState, patch } from './store.js';

export const SYNC_KEY = 'catalyst:prefs';
const SYNC_VERSION = 1;
const SYNCED_SETTINGS = ['theme', 'showPrices', 'showCatalysts', 'showInsiders', 'showExtended', 'sort'];
const MAX_BYTES = 7500;          // headroom under Chrome's 8KB per-item cap

/** Only the fields worth carrying between devices. */
export function buildPayload(state) {
  const settings = {};
  for (const k of SYNCED_SETTINGS) if (state.settings[k] !== undefined) settings[k] = state.settings[k];
  // names and exchanges make a synced list render correctly before its first
  // refresh; logos are excluded because they would blow the per-item quota.
  const meta = {};
  for (const [sym, m] of Object.entries(state.meta || {})) {
    if (!state.symbols.includes(sym)) continue;
    const slim = {};
    if (m?.name) slim.name = m.name;
    if (m?.exchange) slim.exchange = m.exchange;
    if (m?.cls) slim.cls = m.cls;
    if (Object.keys(slim).length) meta[sym] = slim;
  }
  return { v: SYNC_VERSION, symbols: state.symbols, settings, meta };
}

/** Identity of a payload, ignoring its timestamp — used to break write loops. */
export const identity = (p) => JSON.stringify([p?.symbols, p?.settings, p?.meta]);

function withinQuota(payload) {
  return JSON.stringify(payload).length <= MAX_BYTES;
}

let lastPushed = null;

/**
 * chrome.storage.onChanged fires for this extension's OWN sync writes too, so
 * every push echoes straight back. Content comparison alone could not tell the
 * echo apart: refreshes keep updating meta between a push and its echo, so the
 * stale echo looked "different", was applied over newer local state, and
 * triggered a forced full refresh that updated meta again — observed in real
 * Chrome on a single fresh profile. Each install tags its pushes instead.
 */
let deviceIdPromise = null;
export function deviceId() {
  deviceIdPromise ||= (async () => {
    const got = await chrome.storage.local.get('deviceId');
    if (typeof got.deviceId === 'string' && got.deviceId) return got.deviceId;
    const id = crypto.randomUUID();
    await chrome.storage.local.set({ deviceId: id });
    return id;
  })();
  return deviceIdPromise;
}

export async function push(state) {
  const payload = buildPayload(state);
  const id = identity(payload);
  if (id === lastPushed) return 'unchanged';
  if (!withinQuota(payload)) return 'too-large';
  try {
    await chrome.storage.sync.set({ [SYNC_KEY]: { ...payload, at: Date.now(), from: await deviceId() } });
    lastPushed = id;
    return 'pushed';
  } catch {
    return 'error';                 // not signed in, quota, offline — never fatal
  }
}

export async function read() {
  try {
    const got = await chrome.storage.sync.get(SYNC_KEY);
    const p = got?.[SYNC_KEY];
    return p && p.v === SYNC_VERSION && Array.isArray(p.symbols) ? p : null;
  } catch {
    return null;
  }
}

/**
 * Apply a remote payload if it is genuinely newer and genuinely different.
 * @returns 'applied' | 'same' | 'stale' | 'own' | 'invalid'
 */
export async function apply(payload) {
  if (!payload || payload.v !== SYNC_VERSION || !Array.isArray(payload.symbols)) return 'invalid';
  if (payload.from && payload.from === await deviceId()) return 'own';   // our own echo
  const state = await getState();
  if (identity(payload) === identity(buildPayload(state))) {
    lastPushed = identity(payload);            // already matching; stop the loop here
    return 'same';
  }
  if (typeof payload.at === 'number' && payload.at <= (state.prefsAt || 0)) return 'stale';

  const meta = { ...state.meta };
  for (const [sym, m] of Object.entries(payload.meta || {})) {
    meta[sym] = { ...(meta[sym] || {}), ...m };  // keep any locally cached logo
  }
  await patch({
    symbols: payload.symbols,
    settings: { ...state.settings, ...(payload.settings || {}) },
    meta,
    prefsAt: payload.at || Date.now(),
  });
  lastPushed = identity(payload);
  return 'applied';
}

/** Stamp a local preference change so remote payloads can be ordered against it. */
export async function markLocalChange() {
  await patch({ prefsAt: Date.now() });
}
