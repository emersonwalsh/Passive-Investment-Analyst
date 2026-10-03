/**
 * Data accuracy against independent sources, over the real network.
 *
 * Run before every release. The keyless sources are undocumented, so their
 * shapes and semantics can change without notice; this is how you find out
 * before users do.
 *
 *   prices        our provider   vs CNBC consolidated quotes
 *   card links    our URL        vs Google Finance actually resolving it
 *   dates         Nasdaq/Zacks   vs stockanalysis.com (confirmed dates only)
 *   insider buys  Nasdaq rows    vs the SEC Form 4 filings they come from
 *
 * Prices compare exactly when the market is closed and within a small band
 * intraday, when two feeds legitimately tick at different moments.
 */
import { imp, check, section, done } from './lib.mjs';

const N = await imp('src/providers/nasdaq.js');
const R = await imp('src/render.js');
const MH = await imp('src/market-hours.js');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0 Safari/537.36';
// SEC asks automated clients to identify themselves; this names the tool, not a person.
const SEC_UA = 'PassiveInvestmentAnalyst-accuracy-check admin@example.org';
const num = (v) => { const n = Number(String(v ?? '').replace(/[$,%+\s]/g, '')); return Number.isFinite(n) ? n : null; };
const get = async (url, ua = UA, accept = '*/*') => {
  for (let i = 0; i < 3; i++) {
    try { const r = await fetch(url, { headers: { 'User-Agent': ua, Accept: accept } }); if (r.ok) return r; } catch { /* retry */ }
    await new Promise((res) => setTimeout(res, 1200));
  }
  throw new Error(`unreachable: ${url}`);
};

/* ------------------------------------------------------------------ prices */
section('prices vs CNBC consolidated');
{
  const BASKET = ['AAPL','NVDA','MSFT','TSLA','META','AMZN','GOOGL','JPM','KO','SNAP','BRK.B','TSM','BABA','SPY','QQQ','VOO','ARKK','NVR','F','SOFI','ARM','RDDT'];
  const errs = {};
  const phase = MH.marketPhase();
  const ours = await N.getQuotes(BASKET, null, { phase, onError: (s, w) => (errs[s] = w) });
  const cn = {};
  for (let i = 0; i < BASKET.length; i += 10) {
    const url = 'https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols='
      + encodeURIComponent(BASKET.slice(i, i + 10).join('|')) + '&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json';
    for (const q of (await (await get(url)).json())?.FormattedQuoteResult?.FormattedQuote || []) cn[q.symbol] = q;
  }
  const open = MH.isRegularHours();
  const extendedNow = phase === 'pre' || phase === 'after';
  console.log(`  (session: ${phase})`);
  check(`our provider quoted the basket (${Object.keys(ours).length}/${BASKET.length})`, Object.keys(ours).length >= BASKET.length - 1, errs);
  let compared = 0;
  const noReference = [];
  for (const s of BASKET) {
    const o = ours[s]; const c = cn[s];
    if (!o) continue;
    const ref = num(c?.last);
    // CNBC occasionally returns an entry with no price for a symbol it normally
    // covers. That is a missing reference, not a mismatch — but skips are
    // counted, so a source that stops answering can't turn this into a pass.
    if (ref == null || ref <= 0) { noReference.push(s); continue; }
    compared++;
    const tol = open ? Math.max(0.03, ref * 0.004) : 0.011;
    const chg = o.prevClose == null ? null : o.price - o.prevClose;
    // CNBC's `last` is always the REGULAR session price/close, so this also
    // asserts that an extended session never puts the after-hours trade here.
    const okPx = Math.abs(o.price - ref) <= tol;
    const okChg = open || chg == null || Math.abs(chg - num(c.change)) <= 0.011;
    const okPct = open || o.changePct == null || Math.abs(o.changePct - num(c.change_pct)) <= 0.011;
    if (extendedNow && o.ext) {
      const ce = c.ExtendedMktQuote;
      const cePx = num(ce?.last);
      if (cePx != null) {
        const truePct = Math.round(((cePx - ref) / ref) * 1e4) / 100;
        check(`${s.padEnd(6)} extended ${o.ext.price} (${o.ext.changePct}%) vs CNBC ${ce.last} (${ce.change_pct}) — measured against the close`,
          Math.abs(o.ext.price - cePx) <= Math.max(0.05, cePx * 0.004) && Math.abs(o.ext.changePct - truePct) <= 0.05,
          { ours: o.ext, cnbc: { last: ce.last, pct: ce.change_pct }, vsClose: truePct });
      }
    }
    // On an ex-dividend day sources legitimately disagree: Nasdaq measures the
    // day against the raw prior close, CNBC against a dividend-adjusted one.
    // Confirmed with Nasdaq's own historical closes (KO: 89.35 -> 88.71 while
    // CNBC implied 88.82). Narrow on purpose: the price must still match to the
    // cent, and only an adjustment DOWNWARD of a couple of percent is excused,
    // so a mis-framed extended quote is never waved through.
    const cnbcPrev = num(c.previous_day_closing);
    const exDiv = okPx && !open && o.prevClose != null && cnbcPrev != null
      && o.prevClose > cnbcPrev && (o.prevClose - cnbcPrev) / o.price < 0.02;
    if (exDiv && !(okChg && okPct)) console.log(`  (${s}: ex-dividend convention — our prior close ${o.prevClose} vs CNBC ${cnbcPrev}; price matches)`);
    check(`${s.padEnd(6)} ${o.price} (${chg >= 0 ? '+' : ''}${chg?.toFixed(2)}, ${o.changePct}%) vs ${c.last} (${c.change}, ${c.change_pct})`, okPx && (exDiv || (okChg && okPct)),
      { ours: o, cnbc: { last: c.last, change: c.change, pct: c.change_pct }, tolerance: tol });
  }
  if (noReference.length) console.log(`  (CNBC returned no price for ${noReference.join(', ')} — skipped)`);
  check(`enough of the basket had a reference price to mean something (${compared}/${BASKET.length})`, compared >= BASKET.length - 3, noReference);
}

/* ------------------------------------------------------------------- links */
section('every card link opens a real Google Finance quote page');
{
  const SYMS = ['AAPL', 'QQQ', 'JPM', 'BRK.B', 'SPY', 'ARKK', 'FBTC', 'IMO', 'TSM'];
  const metas = {};
  await N.getQuotes(SYMS, null, { onMeta: (s, m) => (metas[s] = m) });
  for (const s of SYMS) {
    const slug = N.googleExchange(metas[s]?.exchange);
    const url = R.gfUrl(s, slug);
    const title = slug ? ((await (await get(url)).text()).match(/<title>([^<]*)/) || [])[1] || '' : '';
    // Google serves its generic "Google Finance" title for a quote it can't resolve.
    check(`${s.padEnd(6)} ${metas[s]?.exchange} -> ${url.replace('https://www.google.com/finance/quote/', '')}`,
      Boolean(slug) && title.trim() !== 'Google Finance', title || '(no exchange slug)');
  }
}

/* ------------------------------------------------------------------- dates */
// Zacks' "expected*" date is NOT company confirmation: in October 2026 it put
// Wells Fargo's Q3 report a day after the date on Wells Fargo's own investor
// relations page. The extension therefore never claims a date is confirmed, and
// this measures the source instead of demanding perfection from it — failing if
// agreement with an independent source drops, and listing every disagreement.
section('earnings dates (Zacks "expected") vs stockanalysis.com');
{
  const POOL = ['JPM','WFC','C','GS','MS','BAC','BLK','PNC','USB','SCHW','AXP','JNJ','UNH','ABT','PG','PEP','KO','PM',
    'MMM','HON','GE','RTX','LMT','BA','CAT','NFLX','TSLA','INTC','IBM','TXN','LRCX','ISRG','ELV','TMO','DHR','VZ','T',
    'TMUS','CMCSA','NEE','XOM','CVX','SLB','UNP','CSX','UPS','MSFT','GOOGL','META','AAPL','AMZN','V','MA','MCD','NKE',
    'HD','WMT','COST','MU','ORCL','ADBE','AVGO','CRM','FDX','GIS','KMX','AZO','PAYX','CTAS','ACN','LEN','DRI'];
  const MON = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
  const today = new Date().toISOString().slice(0, 10);
  let compared = 0, agree = 0, staleRef = 0;
  const off = [];
  for (const s of POOL) {
    if (compared >= 40) break;
    const t = (await (await get(`https://api.nasdaq.com/api/analyst/${s}/earnings-date`, UA, 'application/json')).json())?.data?.reportText || '';
    const m = /expected\*\s+to report earnings on\s+(\d{2})\/(\d{2})\/(\d{4})/i.exec(t);
    if (!m) continue;
    const ours = `${m[3]}-${m[1]}-${m[2]}`;
    const html = await (await get(`https://stockanalysis.com/stocks/${s.toLowerCase()}/`)).text();
    const sm = /earningsDate:"([A-Z][a-z]{2}) (\d{1,2}), (\d{4})/.exec(html);
    if (!sm) continue;
    const theirs = `${sm[3]}-${String(MON[sm[1]]).padStart(2, '0')}-${String(+sm[2]).padStart(2, '0')}`;
    // A reference still showing the LAST report (already past) has not been
    // updated; it says nothing about the next date.
    if (theirs < today) { staleRef++; continue; }
    compared++;
    if (ours === theirs) agree++; else off.push(`${s} ${ours} vs ${theirs}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  const rate = compared ? agree / compared : 0;
  if (off.length) console.log(`  (disagreements: ${off.join('; ')})`);
  if (staleRef) console.log(`  (${staleRef} reference(s) skipped: still showing a past date)`);
  check(`compared enough dates to mean something (${compared})`, compared >= 15, compared);
  check(`Zacks' expected dates agree with an independent source ${agree}/${compared} (${(rate * 100).toFixed(0)}%, floor 90%)`, rate >= 0.9, off);
}

/* ---------------------------------------------------------------- insiders */
section('insider buys vs SEC Form 4 filings');
{
  const tickers = await (await get('https://www.sec.gov/files/company_tickers.json', SEC_UA)).json();
  const CIK = Object.fromEntries(Object.values(tickers).map((v) => [v.ticker.toUpperCase(), String(v.cik_str).padStart(10, '0')]));
  const UNIVERSE = ['KDP','INTC','PFE','BA','NKE','TGT','CVS','DIS','F','GM','UNH','PYPL','EL','KHC','WBA','MRK','T','VZ','OXY','SBUX',
    'LULU','DG','ALB','MOS','FMC','CMCSA','WBD','PARA','MMM','DOW','HUM','CI','ELV','BMY','GILD','USB','KEY','TFC','EA','ETSY'];
  const rows = [];
  for (const s of UNIVERSE) {
    const j = await (await get(`https://api.nasdaq.com/api/company/${s}/insider-trades?limit=40&type=ALL`, UA, 'application/json')).json();
    for (const r of j?.data?.transactionTable?.table?.rows || []) {
      if ((r.transactionType || '').trim() !== 'Buy') continue;
      const d = new Date(r.lastDate);
      if (Date.now() - d > 75 * 864e5) continue;
      rows.push({ s, who: r.insider, rawDate: r.lastDate, date: d, shares: num(r.sharesTraded), price: num(r.lastPrice), held: num(r.sharesHeld) });
    }
    if (rows.length >= 6) break;
  }
  const v = (block, tag) => { const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block); if (!m) return null; const mv = /<value>\s*([^<]*?)\s*<\/value>/.exec(m[1]); return (mv ? mv[1] : m[1].replace(/<[^>]+>/g, '')).trim() || null; };
  const sec = {};
  for (const r of rows) {
    if (!sec[r.s]) {
      sec[r.s] = [];
      const sub = await (await get(`https://data.sec.gov/submissions/CIK${CIK[r.s]}.json`, SEC_UA)).json();
      const f = sub.filings.recent;
      for (let i = 0; i < f.form.length; i++) {
        if (!/^4/.test(f.form[i]) || new Date(f.filingDate[i]) < Date.now() - 90 * 864e5) continue;
        const doc = f.primaryDocument[i].split('/').pop();
        const xml = await (await get(`https://www.sec.gov/Archives/edgar/data/${+CIK[r.s]}/${f.accessionNumber[i].replace(/-/g, '')}/${doc}`, SEC_UA)).text();
        const owner = v(xml, 'rptOwnerName');
        for (const blk of xml.match(/<nonDerivativeTransaction>[\s\S]*?<\/nonDerivativeTransaction>/g) || []) {
          sec[r.s].push({ owner, code: v(blk, 'transactionCode'), date: v(blk, 'transactionDate'), shares: +v(blk, 'transactionShares'), price: +v(blk, 'transactionPricePerShare') });
        }
        await new Promise((res) => setTimeout(res, 150));
      }
    }
    const iso = r.date.toISOString().slice(0, 10);
    const surname = (n) => String(n).toUpperCase().replace(/,/g, ' ').split(/\s+/)[0];
    const matches = sec[r.s].filter((t) => surname(t.owner) === surname(r.who) && t.date === iso && t.code === 'P');
    const secShares = matches.reduce((a, t) => a + t.shares, 0);
    const secValue = matches.reduce((a, t) => a + t.shares * t.price, 0);
    check(`${r.s.padEnd(5)} ${r.who}: Nasdaq "Buy" is an SEC open-market purchase (code P)`, matches.length > 0, sec[r.s].filter((t) => surname(t.owner) === surname(r.who)).slice(0, 3));
    if (matches.length) {
      check(`${r.s.padEnd(5)} ${r.who}: shares ${r.shares} match the filing`, Math.abs(r.shares - secShares) < 1, { nasdaq: r.shares, sec: secShares });
      check(`${r.s.padEnd(5)} ${r.who}: value $${Math.round(r.shares * r.price)} matches the filing`, Math.abs(r.shares * r.price - secValue) <= Math.max(1, secValue * 0.005), { nasdaq: r.shares * r.price, sec: secValue });
    }
  }
  if (!rows.length) console.log('  (no open-market insider buys in the sample window — nothing to verify today)');

  // Every row's link must land on the SEC's own record of that purchase. Built
  // with the extension's code, from the name exactly as the extension stores
  // it, then run as the same search on SEC full-text search.
  section('each insider row links to its SEC filing');
  for (const r of rows) {
    const who = N.titleCase(r.who);
    const url = R.secFilingUrl(r.s, who, r.rawDate);
    const params = Object.fromEntries(new URLSearchParams(url.split('#/')[1]));
    const api = 'https://efts.sec.gov/LATEST/search-index?' + new URLSearchParams(params).toString();
    const hits = (await (await get(api, SEC_UA, 'application/json')).json())?.hits?.hits || [];
    const issuer = `CIK ${CIK[r.s]}`;
    const surname = who.split(/\s+/)[0].toUpperCase();
    const match = hits.find((h) => (h._source?.display_names || []).some((n) => n.includes(issuer))
      && (h._source?.display_names || []).some((n) => n.toUpperCase().includes(surname))
      && (h._source?.root_forms || h._source?.forms || []).some((f) => String(f).startsWith('4')));
    check(`${r.s.padEnd(5)} ${who}: link finds the Form 4 (${hits.length} result${hits.length === 1 ? '' : 's'})`, Boolean(match),
      { url, hits: hits.slice(0, 3).map((h) => h._source?.display_names) });
    await new Promise((res) => setTimeout(res, 150));
  }
}

done('data accuracy');
