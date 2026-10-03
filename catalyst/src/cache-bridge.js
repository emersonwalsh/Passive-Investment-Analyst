/**
 * localStorage mirror of the slice of chrome.storage the first paint needs.
 *
 * chrome.storage.local.get is async; awaiting it before paint flashes an empty
 * screen. localStorage on an extension page is synchronous, so the boot script
 * reads it and paints in the same tick.
 *
 * One-directional: the MV3 service worker has no localStorage, so only the new
 * tab page writes here, after chrome.storage tells it something changed.
 *
 * The API key is deliberately never mirrored — the boot path doesn't need it.
 */

export const CACHE_KEY = 'cache:v1';
export const CACHE_VERSION = 1;

export function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    return p && p.v === CACHE_VERSION ? p : null;
  } catch {
    return null;
  }
}

export function writeCache(state) {
  try {
    const payload = {
      v: CACHE_VERSION,
      ready: Boolean(state.settings?.apiKey) || state.symbols.length > 0,
      symbols: state.symbols,
      meta: state.meta || {},
      theme: state.settings?.theme || 'auto',
      showPrices: state.settings?.showPrices !== false,
      showCatalysts: state.settings?.showCatalysts !== false,
      showInsiders: state.settings?.showInsiders !== false,
      showExtended: state.settings?.showExtended !== false,
      sort: state.settings?.sort || { by: 'change', dir: 'desc' },
      quotes: {
        fetchedAt: state.quotes.fetchedAt, fetchingSince: state.quotes.fetchingSince || 0,
        unknown: state.quotes.unknown || {},
        stale: state.quotes.stale, reason: state.quotes.reason || null, data: state.quotes.data,
      },
      catalysts: { fetchedAt: state.catalysts.fetchedAt, stale: state.catalysts.stale, data: state.catalysts.data },
      series: { fetchedAt: state.series.fetchedAt, data: state.series.data },
      results: { fetchedAt: state.results.fetchedAt, data: state.results.data },
      insiders: { fetchedAt: state.insiders.fetchedAt, data: state.insiders.data },
      stale: Boolean(state.quotes.stale || state.catalysts.stale),
    };
    localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
  } catch {
    /* quota or private mode — the page still works, it just re-reads async next time */
  }
}

export function clearCache() {
  try { localStorage.removeItem(CACHE_KEY); } catch { /* ignore */ }
}
