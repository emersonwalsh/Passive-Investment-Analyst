/**
 * Quotes must mean the same thing in every session.
 *
 * The bug this exists for: during pre-market and after-hours, Nasdaq's quote
 * block describes the EXTENDED trade and measures its change against that day's
 * regular close. Read as an ordinary quote, the after-hours price lands in the
 * day's slot and the day's move is replaced by the after-hours move. Live case:
 * SHOP closed at 129.86, down 3.01%; after hours it traded at 130.00, +0.14
 * (+0.11%) against that close. The card showed "130.00 +0.11%".
 */
import { imp, check, section, done, fakeChrome, installClock, etSept, sendMessage, until } from './lib.mjs';

const N = await imp('src/providers/nasdaq.js');

/* ------------------------------------------------- reading a single payload */
section('reading a quote in the frame of its session');
const payload = (last, net, pct, status) => ({ marketStatus: status, primaryData: { lastSalePrice: `$${last}`, netChange: net, percentageChange: pct } });

{
  // SHOP, 15 Sep 2026: closed 129.86 (-4.03, -3.01% from 133.89), then 130.00 after hours.
  const REGULAR = payload('129.86', '-4.03', '-3.01%', 'Market Open');
  const AFTER = payload('130.00', '+0.14', '+0.11%', 'After Hours');
  const CLOSED = payload('129.86', '-4.03', '-3.01%', 'Closed');

  const open = N.readQuote(REGULAR, { extended: false });
  check('during the session: the live price and the day move', open.price === 129.86 && open.changePct === -3.01 && open.prevClose === 133.89, open);

  const after = N.readQuote(AFTER, { extended: true, prevCloseHint: 133.89 });
  check('after hours: the card keeps the CLOSE, not the after-hours price', after.price === 129.86, after);
  check('after hours: the card keeps the DAY move, not the after-hours move', after.changePct === -3.01, after);
  check('after hours: the previous close is untouched by extended trading', after.prevClose === 133.89, after);
  check('after hours: the extended figures come free, measured against the close', after.ext.price === 130 && after.ext.changePct === 0.11, after.ext);

  const closed = N.readQuote(CLOSED, { extended: false });
  check('overnight: the official close and the day move', closed.price === 129.86 && closed.changePct === -3.01 && closed.prevClose === 133.89, closed);

  // Next morning pre-market: 131.00, +1.14 (+0.88%) against the 129.86 close.
  const pre = N.readQuote(payload('131.00', '+1.14', '+0.88%', 'Pre-Market'), { extended: true, prevCloseHint: 133.89 });
  check('pre-market: the card still shows the last completed session', pre.price === 129.86 && pre.changePct === -3.01, pre);
  check('pre-market: the extended line shows the pre-market trade', pre.ext.price === 131 && pre.ext.changePct === 0.88, pre.ext);

  check('"UNCH" is zero change, not a missing value', N.readQuote(payload('50.00', 'UNCH', '0.00%', 'Closed'), { extended: false }).prevClose === 50);
  check('an extended payload with an unreadable change is skipped, never guessed',
    N.readQuote(payload('130.00', 'N/A', 'N/A', 'After Hours'), { extended: true, prevCloseHint: 133.89 }) === null);
  // Live, 17 Sep 2026 16:05 ET: SHOP's quote had an empty change field and
  // last = 128.60, exactly the official close, while CNBC showed 128.62 after hours.
  const empty = N.readQuote(payload('128.60', '', '', 'After-Hours'), { extended: true, prevCloseHint: 129.96 });
  check('an EMPTY change field means the price is the close', empty?.price === 128.6 && empty?.changePct === -1.05, empty);
  check('and carries no extended line of its own', empty && !empty.ext, empty);
  // 300.00 with a +10.00 change implies a 290 close against a 133.89 previous
  // one: these fields are not what we think they are, so publish nothing.
  check('a "close" nowhere near the previous one is refused',
    N.readQuote(payload('300.00', '+10.00', '+3.4%', 'After Hours'), { extended: true, prevCloseHint: 133.89 }) === null);
  check('a normal overnight gap is still accepted',
    N.readQuote(payload('118.00', '+0.20', '+0.17%', 'After Hours'), { extended: true, prevCloseHint: 133.89 })?.price === 117.8);
  // Live, Monday 28 Sep 2026 at 4:02am: SHOP's Friday close was 142.25 (-2.00%
  // from Thursday's 145.16), but Nasdaq measured the pre-market trade against
  // THURSDAY's close, so last - net recovers 145.16.
  const ROLLOVER = payload('142.2716', '-2.8884', '-1.99%', 'Pre-Market');
  check('the 4am rollover payload is refused when the card already holds the later close',
    N.readQuote(ROLLOVER, { extended: true, prevCloseHint: 145.16, priceHint: 142.25, guardRollover: true }) === null);
  check('the guard does not fire after hours, where a stock can genuinely close unchanged',
    N.readQuote(payload('100.10', '+0.10', '+0.10%', 'After-Hours'), { extended: true, prevCloseHint: 100, priceHint: 100.02, guardRollover: false })?.price === 100);
  check('nor for a stock whose last session really was unchanged',
    N.readQuote(payload('100.30', '+0.30', '+0.30%', 'Pre-Market'), { extended: true, prevCloseHint: 100, priceHint: 100, guardRollover: true })?.price === 100);
  check('Nasdaq\'s real label "After-Hours" (hyphenated) reads as extended', N.quoteFrame('After-Hours', 'closed') === 'extended');
  const noHint = N.readQuote(AFTER, { extended: true });
  check('with no previous close known, show the close and no percentage — never a wrong one',
    noHint.price === 129.86 && noHint.changePct === null, noHint);
}

/* ------------------------------------------------------ choosing the frame */
section('choosing the frame');
{
  check("Nasdaq's own label wins: open", N.quoteFrame('Market Open', 'after') === 'regular');
  check("Nasdaq's own label wins: after hours", N.quoteFrame('After Hours', 'open') === 'extended');
  check('pre-market label', N.quoteFrame('Pre-Market', 'closed') === 'extended');
  check('no label: our clock decides (after hours)', N.quoteFrame('', 'after') === 'extended');
  check('no label: our clock decides (open)', N.quoteFrame('', 'open') === 'regular');
  check('"Closed" during our after-hours window still reads as extended', N.quoteFrame('Closed', 'after') === 'extended');
  check('overnight is an ordinary closed quote', N.quoteFrame('Closed', 'closed') === 'regular');
  // The day after Thanksgiving closes at 13:00; a calendar alone would call 14:00 "open".
  check('a half-day is handled by the label, not the calendar', N.quoteFrame('After Hours', 'open') === 'extended');
}

/* ------------------------------------- the exact thing the user did, in the worker */
section('clicking refresh during after-hours (the reported failure)');
{
  const at = etSept(15, 16, 28);          // 4:28pm ET, post-market — the moment in the screenshot
  installClock(at);
  const store = {
    schemaVersion: 4, symbols: ['SHOP'], prefsAt: 0,
    settings: { apiKey: null, showPrices: true, showCatalysts: true, showInsiders: true, showExtended: true, theme: 'auto', sort: { by: 'change', dir: 'desc' } },
    meta: { SHOP: { name: 'Shopify Inc.', exchange: 'NASDAQ', cls: 'stocks', logo: null } },
    quotes: { fetchedAt: at - 40 * 60e3, fetchingSince: 0, stale: false, reason: null, unknown: {}, data: { SHOP: { price: 129.86, changePct: -3.01, prevClose: 133.89 } } },
    catalysts: { fetchedAt: at, scannedAt: at, stale: false, data: { SHOP: [] }, tried: {} },
    series: { fetchedAt: at, stale: false, data: { SHOP: [129, 130] } },
    results: { fetchedAt: at, data: {} }, insiders: { fetchedAt: at, seen: { SHOP: 1 }, data: {} },
  };
  const fc = fakeChrome(store);
  globalThis.chrome = fc.chrome;
  globalThis.fetch = async (u) => {
    const url = String(u);
    const j = (b) => ({ ok: true, status: 200, json: async () => b });
    if (/\/info\?assetclass=stocks/.test(url)) return j({ data: { ...payload('130.00', '+0.14', '+0.11%', 'After Hours'), companyName: 'Shopify Inc.', exchange: 'NASDAQ-GS' } });
    if (/extended-trading/.test(url)) return j({ data: { infoTable: { rows: [{ consolidated: '$130.36 -3.53 (-2.64%)' }] } } });
    if (/\/chart/.test(url)) return j({ data: { company: 'Shopify Inc.', exchange: 'NASDAQ-GS', chart: [{ y: 129 }, { y: 130 }] } });
    if (/earnings-date/.test(url)) return j({ data: { reportText: 'no date' } });
    if (/insider-trades/.test(url)) return j({ data: { transactionTable: { table: { rows: [] } } } });
    return j({});
  };
  await imp('src/background.js');
  await sendMessage(fc.listeners, { type: 'refresh', reason: 'user' });
  await until(async () => (await fc.chrome.storage.local.get('quotes')).quotes.fetchedAt > at - 60e3, 8000, 50);
  await new Promise((r) => setTimeout(r, 900));
  const q = (await fc.chrome.storage.local.get('quotes')).quotes.data.SHOP;
  check(`a forced refresh after hours keeps the day's price (${q.price})`, q.price === 129.86, q);
  check(`and the day's move (${q.changePct}%), not the after-hours move`, q.changePct === -3.01, q);
  check('the previous close is not overwritten with today\'s close', q.prevClose === 133.89, q);
  // The quote request itself carries the extended trade, so it is used as-is
  // and the dedicated extended-hours call is not needed.
  check(`the after-hours line shows the extended trade against the close (${q.ext?.price} / ${q.ext?.changePct}%)`,
    q.ext && q.ext.price === 130 && q.ext.changePct === 0.11, q.ext);
}

done('quotes');
