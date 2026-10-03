/**
 * Service-worker lifetime under the heaviest realistic load.
 *
 * Chrome terminates an extension service worker after 30s without an extension
 * event or API call — and an in-flight fetch() does NOT count. A 25-ticker
 * refresh started by an alarm is mostly network, so it can be killed mid-pass,
 * restart on the next alarm, get killed again, and never finish.
 *
 * DevTools keeps a worker alive while attached, so this test sets state,
 * DETACHES, lets a real alarm fire, watches the worker's lifecycle from the
 * browser target only, and re-attaches at the end to see what got done.
 *
 *   node tests/lifetime.test.mjs      (~3 minutes, real network)
 */
import { launch, attach, shutdown } from './cdp.mjs';
import { check, section, done, until } from './lib.mjs';

const WATCHLIST = ['AAPL','MSFT','NVDA','AMZN','GOOGL','META','TSLA','INTC','JPM','KO','PFE','DIS','NKE','COST','ORCL',
  'ADBE','CRM','AMD','NFLX','SPY','QQQ','BRK.B','XOM','WMT','COIN'];

const b = await launch();
try {
  section(`25-ticker refresh started by an alarm, no debugger attached (${b.version})`);
  let sw = await attach(b.cdp, b.swTargetId);
  const S = (expr) => b.cdp.eval(sw.sessionId, expr);
  // Let the ENTIRE install pass finish. Waiting on quotes alone let the install's
  // calendar pass land after the reset below and restamp scannedAt, silently
  // turning the worst case into an easy one.
  await until(async () => {
    const x = await S('chrome.storage.local.get(null)');
    return x.quotes?.fetchedAt > 0 && x.catalysts?.fetchedAt > 0 && x.series?.fetchedAt > 0 && x.insiders?.fetchedAt > 0;
  }, 120000, 500);
  await new Promise((r) => setTimeout(r, 5000));

  // Worst case: nothing cached for 25 tickers, so every refresher does full work
  // and the calendar scan is due.
  await S(`(async () => {
    const s = await chrome.storage.local.get(null);
    await chrome.storage.local.set({
      symbols: ${JSON.stringify(WATCHLIST)},
      meta: {}, diag: { build: s.diag?.build },
      quotes: { fetchedAt: 0, fetchingSince: 0, stale: false, reason: null, unknown: {}, data: {} },
      catalysts: { fetchedAt: 0, scannedAt: 0, stale: false, data: {} },
      series: { fetchedAt: 0, stale: false, data: {} },
      insiders: { fetchedAt: 0, seen: {}, data: {} },
      results: { fetchedAt: 0, data: {} },
    });
    // All three due at once — what happens when Chrome starts after a night off.
    const when = Date.now() + 8000;
    await chrome.alarms.create('refresh-quotes', { when, periodInMinutes: 15 });
    await chrome.alarms.create('refresh-catalysts', { when, periodInMinutes: 1440 });
    await chrome.alarms.create('refresh-series', { when, periodInMinutes: 30 });
    return true;
  })()`);

  const armed = await S('chrome.storage.local.get(["catalysts","quotes"]).then((x) => ({ scannedAt: x.catalysts.scannedAt, cat: x.catalysts.fetchedAt, q: x.quotes.fetchedAt }))');
  check('worst case is really armed (nothing cached, scan due)', armed.scannedAt === 0 && armed.cat === 0 && armed.q === 0, armed);

  // Watch lifecycle without attaching.
  const events = [];
  const t0 = Date.now();
  const swUrl = `chrome-extension://${b.extId}/src/background.js`;
  b.cdp.on((m) => {
    if (m.method === 'Target.targetCreated' && m.params.targetInfo.url === swUrl) events.push({ at: Date.now(), e: 'worker started' });
    if (m.method === 'Target.targetDestroyed') events.push({ at: Date.now(), e: 'target destroyed', id: m.params.targetId });
  });
  await b.cdp.send('Target.detachFromTarget', { sessionId: sw.sessionId });

  await new Promise((r) => setTimeout(r, 180000));   // 3 minutes, hands off

  const { targetInfos } = await b.cdp.send('Target.getTargets');
  const live = targetInfos.find((t) => t.url === swUrl);
  if (!live) {   // wake it just to read storage; the measurement window is over
    const { targetId } = await b.cdp.send('Target.createTarget', { url: `chrome-extension://${b.extId}/newtab.html` });
    await until(async () => (await b.cdp.send('Target.getTargets')).targetInfos.some((t) => t.url === swUrl), 15000, 200);
    await b.cdp.send('Target.closeTarget', { targetId });
  }
  const swNow = (await b.cdp.send('Target.getTargets')).targetInfos.find((t) => t.url === swUrl);
  sw = await attach(b.cdp, swNow.targetId);
  const st = await b.cdp.eval(sw.sessionId, 'chrome.storage.local.get(null)');

  const killed = events.filter((e) => e.e === 'target destroyed' && e.id === b.swTargetId);
  const rel = (ms) => (ms ? `+${((ms - t0) / 1000).toFixed(1)}s` : '—');
  const d = st.diag || {};
  console.log(`        alarms due          ${rel(t0 + 8000)}`);
  for (const k of ['logos', 'insiders', 'quotes', 'series', 'catalysts', 'sync']) if (d[k]) console.log(`        ${k.padEnd(10)} wrote   ${rel(d[k].at)}  ${JSON.stringify(d[k])}`);
  for (const e of events) console.log(`        ${e.e.padEnd(18)}  ${rel(e.at)}`);
  // Use the DATA timestamps, not diag: re-waking the worker to read storage
  // overwrites diag with that wake's own skip entries.
  const lastWork = Math.max(st.quotes?.fetchedAt || 0, st.catalysts?.fetchedAt || 0, st.series?.fetchedAt || 0, st.insiders?.fetchedAt || 0);
  console.log(`        refresh finished    ${rel(lastWork)}  (quotes ${rel(st.quotes?.fetchedAt)}, calendar ${rel(st.catalysts?.fetchedAt)}, sparklines ${rel(st.series?.fetchedAt)})`);
  const firstKill = killed[0]?.at;
  if (firstKill) console.log(`        worker terminated ${((firstKill - lastWork) / 1000).toFixed(1)}s after its last completed write`);
  const priced = WATCHLIST.filter((s) => st.quotes?.data?.[s]?.price > 0);
  const checked = WATCHLIST.filter((s) => Array.isArray(st.catalysts?.data?.[s]));
  const sparks = WATCHLIST.filter((s) => Array.isArray(st.series?.data?.[s]) && st.series.data[s].length > 1);
  check(`quotes finished for the watchlist (${priced.length}/25)`, priced.length >= 24, WATCHLIST.filter((s) => !priced.includes(s)));
  check(`sparklines finished (${sparks.length}/25)`, sparks.length >= 23, WATCHLIST.filter((s) => !sparks.includes(s)));
  check(`the calendar pass finished (${checked.length}/25 checked, fetchedAt ${st.catalysts?.fetchedAt ? 'set' : 'NOT set'})`, st.catalysts?.fetchedAt > 0 && checked.length >= 23, st.diag?.catalysts);
  check('no pending fetch left stranded', !st.quotes?.fetchingSince, st.quotes?.fetchingSince);
  // Chrome's idle timeout is 30s. A termination >= ~28s after the last write is
  // the normal shutdown of a finished worker; anything sooner means it died with
  // work still outstanding.
  check('worker was never terminated with work outstanding', !firstKill || (firstKill - lastWork) >= 25000,
    { killedAfterLastWriteMs: firstKill ? firstKill - lastWork : null });
} catch (e) {
  check('lifetime test ran to completion', false, e.stack);
} finally {
  await shutdown(b);
}
done('service-worker lifetime');
