/**
 * Replays captured live market data through the real quote code path.
 *
 * Every sample's actual Nasdaq payload is served to getQuotes(), and the
 * extension's fetch policy is emulated at each sample's real time — fetch during
 * the regular session and extended sessions, otherwise only until a card has
 * been read after the close settled. Each resulting card is then compared with
 * CNBC's quote taken at the same moment.
 *
 * This is the test that would have caught the after-hours bug: it runs the code
 * against every session of real trading days rather than whatever hour the
 * suite happens to run at.
 *
 *   node tests/replay.test.mjs [capture.jsonl]   (default: every capture in tests/fixtures/local/)
 */
import fs from 'node:fs';
import path from 'node:path';
import { imp, check, section, done, TESTS } from './lib.mjs';

const N = await imp('src/providers/nasdaq.js');
const MH = await imp('src/market-hours.js');
const num = (v) => { const s = String(v ?? '').replace(/[$,%+\s]/g, ''); if (/^unch$/i.test(s)) return 0; const n = s === '' ? NaN : Number(s); return Number.isFinite(n) ? n : null; };

const dir = path.join(TESTS, 'fixtures/local');
const files = process.argv[2] ? [process.argv[2]]
  : fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(dir, f)) : [];
if (!files.length) {
  console.log('no live captures found in tests/fixtures/local/ — record one with tests/capture-sessions.mjs');
  process.exit(0);
}
const rows = files.flatMap((f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)))
  .filter((r) => r.info?.primary && r.cnbc?.last).sort((a, b) => a.at.localeCompare(b.at));

const cards = {};
const stats = {};
const misses = {};
const bump = (k, ok, detail) => {
  const s = (stats[k] ||= { n: 0, ok: 0 });
  s.n++; if (ok) s.ok++; else (misses[k] ||= []).push(detail);
};
let fetches = 0;
for (const r of rows) {
  const t = Date.parse(r.at);
  const phase = r.phase === 'post' ? 'after' : r.phase;
  const card = cards[r.sym];
  const shouldFetch = phase === 'open' || phase === 'pre' || phase === 'after' || !(card?.at >= MH.lastSettledCloseAt(t));
  if (shouldFetch) {
    fetches++;
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: { marketStatus: r.info.status, primaryData: r.info.primary } }) });
    const got = await N.getQuotes([r.sym], null, {
      phase, classOf: { [r.sym]: 'stocks' },
      prevCloseOf: card?.prevClose != null ? { [r.sym]: card.prevClose } : {},
      priceOf: card?.price != null ? { [r.sym]: card.price } : {},
    });
    if (got[r.sym]) cards[r.sym] = { ...got[r.sym], at: t };
  }
  const c = cards[r.sym];
  if (!c) continue;
  const ref = num(r.cnbc.last); const refPct = num(r.cnbc.pct);
  const et = r.etHour;
  const detail = { at: r.at, et, phase: r.phase, status: r.info.status, sym: r.sym, card: { price: c.price, pct: c.changePct }, cnbc: { last: r.cnbc.last, pct: r.cnbc.pct } };
  if (r.phase === 'open') {
    // two live feeds sampled at the same instant still tick independently
    bump('regular session (live)', Math.abs(c.price - ref) <= Math.max(0.03, ref * 0.004) && Math.abs(c.changePct - refPct) <= 0.45, detail);
  } else if (r.phase === 'post' && et < 16 + 10 / 60) {
    // the first minutes after the bell: Nasdaq's reference close is provisional
    bump('16:00-16:09 (close still settling)', Math.abs(c.price - ref) <= 0.15, detail);
  } else if (r.phase === 'pre' && et < 4.25) {
    bump('4:00-4:14 pre-market (rollover)', Math.abs(c.price - ref) <= 0.011, detail);
  } else {
    const key = r.phase === 'post' ? 'after-hours from 16:10' : r.phase === 'pre' ? 'pre-market from 4:15' : 'overnight / weekend';
    bump(key, Math.abs(c.price - ref) <= 0.011 && c.changePct != null && Math.abs(c.changePct - refPct) <= 0.011, detail);
  }
  if ((r.phase === 'post' || r.phase === 'pre') && c.ext && r.cnbc.ext?.last) {
    const vsClose = Math.round(((c.ext.price - c.price) / c.price) * 1e4) / 100;
    bump('extended line measured against the close', Math.abs(c.ext.changePct - vsClose) <= 0.02, { ...detail, ext: c.ext, vsClose });
  }
}

const days = new Set(rows.map((r) => r.at.slice(0, 10))).size;
section(`replay: ${rows.length} live samples, ${days} days, ${[...new Set(rows.map((r) => r.sym))].join('/')} (${fetches} emulated fetches)`);
for (const [k, s] of Object.entries(stats)) {
  const exact = !k.startsWith('regular') && !k.startsWith('16:00');
  check(`${k}: ${s.ok}/${s.n} ${exact ? 'exact to the cent' : 'within tolerance'}`, s.ok === s.n, (misses[k] || []).slice(0, 4));
}
done('live replay');
