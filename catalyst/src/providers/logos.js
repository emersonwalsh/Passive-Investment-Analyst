/**
 * Company logos. Keyless, and deliberately sourced from two independent CDNs so
 * one going away degrades coverage instead of removing logos entirely.
 *
 * Order matters. Financial Modeling Prep is tried first: it covers tickers
 * Finnhub misses (META, FIG), returns an honest 404 for unknown symbols, and
 * ships 100-250px sources rather than Finnhub's 1000x1000. Finnhub is the
 * fallback — note it keys some companies by their *former* ticker (META lives
 * at FB.png), which is exactly why it can't be the only source.
 */

import { gatedFetch } from '../net.js';

const SOURCES = [
  (sym) => `https://financialmodelingprep.com/image-stock/${encodeURIComponent(sym)}.png`,
  (sym) => `https://static2.finnhub.io/file/publicdatany/finnhubimage/stock_logo/${encodeURIComponent(sym)}.png`,
];

const LOGO_PX = 40;              // 2x the 18px render box, for retina
const CONCURRENCY = 3;
const MAX_BYTES = 20 * 1024;     // never let a logo bloat the synchronous cache

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** Downscale + re-encode. The cache is JSON.parsed synchronously on every new
 *  tab, so raw source images can never be stored. */
async function shrink(blob) {
  const bmp = await createImageBitmap(blob);
  try {
    if (!bmp.width || !bmp.height) return null;
    const canvas = new OffscreenCanvas(LOGO_PX, LOGO_PX);
    const ctx = canvas.getContext('2d');
    const scale = Math.min(LOGO_PX / bmp.width, LOGO_PX / bmp.height);
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    ctx.drawImage(bmp, Math.round((LOGO_PX - w) / 2), Math.round((LOGO_PX - h) / 2), w, h);
    const out = await canvas.convertToBlob({ type: 'image/webp', quality: 0.86 });
    if (out.size > MAX_BYTES) return null;
    return `data:image/webp;base64,${toBase64(await out.arrayBuffer())}`;
  } finally {
    bmp.close?.();
  }
}

/** @returns {'ok'|'missing'|'error'} alongside the data URI */
async function tryOne(url, signal) {
  try {
    const res = await gatedFetch(url, { signal });
    if (res.status === 404) return { state: 'missing' };
    if (!res.ok) return { state: 'error' };
    if (!(res.headers.get('content-type') || '').startsWith('image/')) return { state: 'missing' };
    const blob = await res.blob();
    if (blob.size < 64) return { state: 'missing' };
    const uri = await shrink(blob);
    return uri ? { state: 'ok', uri } : { state: 'missing' };
  } catch {
    // A decode failure means the bytes weren't really an image; a network
    // failure means try again later. Both surface here, so treat as retryable.
    return { state: 'error' };
  }
}

async function mapLimit(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx]); }
  }));
}

/**
 * -> { NVDA: "data:image/webp;base64,...", XYZ: null }
 *
 * `null` means every source was checked and none had a logo. A symbol is
 * OMITTED when a source failed transiently, so it retries later rather than
 * being permanently recorded as logo-less.
 */
export async function getLogos(symbols, _apiKey, { signal } = {}) {
  const out = {};
  await mapLimit(symbols, CONCURRENCY, async (sym) => {
    let sawError = false;
    for (const buildUrl of SOURCES) {
      const r = await tryOne(buildUrl(sym), signal);
      if (r.state === 'ok') { out[sym] = r.uri; return; }
      if (r.state === 'error') sawError = true;
    }
    // Only record "no logo exists" if every source answered definitively.
    if (!sawError) out[sym] = null;
  });
  return out;
}

export const id = 'logos';
