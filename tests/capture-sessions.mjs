/**
 * Samples Nasdaq and CNBC through real trading sessions so the quote model is
 * validated against live data, not inference. Appends one JSON line per sample.
 *
 *   node tests/capture-sessions.mjs tests/fixtures/local/sessions-YYYY-MM.jsonl
 *
 * Let it run across at least one full trading day (4am-8pm ET) and a weekend,
 * then `node tests/replay.test.mjs`. Stop it when done: it polls every 5 min.
 * Captures stay in tests/fixtures/local/, which is gitignored, because they are
 * raw third-party market data and not ours to republish.
 */
import fs from 'node:fs';

const OUT = process.argv[2];
if (!OUT) { console.error('usage: node tests/capture-sessions.mjs <out.jsonl>'); process.exit(1); }
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';
const SYMS = ['SHOP', 'AAPL', 'INTC'];
const j = async (u) => (await fetch(u, { headers: { 'User-Agent': UA, Accept: 'application/json' } })).json();
const etHour = () => {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(new Date());
  const g = (t) => +p.find((x) => x.type === t).value;
  return (g('hour') % 24) + g('minute') / 60;
};
const phaseOf = (h) => (h < 4 || h >= 20 ? 'closed' : h < 9.5 ? 'pre' : h < 16 ? 'open' : 'post');

let last = null;
for (;;) {
  const h = etHour();
  const ph = phaseOf(h);
  const day = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  const tradingDay = !['Sat', 'Sun'].includes(day);
  // every phase change, always near a session boundary, and a third of the rest
  const nearEdge = [4, 9.5, 16, 20].some((e) => Math.abs(h - e) < 0.2);
  if (ph !== last || nearEdge || Math.random() < 0.34) {
    for (const s of SYMS) {
      try {
        const [info, chart, summary, ext, cn] = await Promise.all([
          j(`https://api.nasdaq.com/api/quote/${s}/info?assetclass=stocks`),
          j(`https://api.nasdaq.com/api/quote/${s}/chart?assetclass=stocks`),
          j(`https://api.nasdaq.com/api/quote/${s}/summary?assetclass=stocks`),
          j(`https://api.nasdaq.com/api/quote/${s}/extended-trading?assetclass=stocks&markettype=${ph === 'pre' ? 'pre' : 'post'}`),
          j(`https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=${s}&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json`),
        ]);
        const q = cn?.FormattedQuoteResult?.FormattedQuote?.[0] || {};
        fs.appendFileSync(OUT, `${JSON.stringify({
          at: new Date().toISOString(), etHour: +h.toFixed(2), phase: ph, tradingDay, sym: s,
          info: { status: info?.data?.marketStatus, primary: info?.data?.primaryData, secondary: info?.data?.secondaryData },
          chart: { last: chart?.data?.lastSalePrice, net: chart?.data?.netChange, pct: chart?.data?.percentageChange, prev: chart?.data?.previousClose },
          summary: { prevClose: summary?.data?.summaryData?.PreviousClose?.value },
          extended: { prevInfo: ext?.data?.previousInfo, row: ext?.data?.infoTable?.rows?.[0]?.consolidated },
          cnbc: {
            last: q.last, change: q.change, pct: q.change_pct, prev: q.previous_day_closing, status: q.curmktstatus,
            ext: q.ExtendedMktQuote && { last: q.ExtendedMktQuote.last, pct: q.ExtendedMktQuote.change_pct, type: q.ExtendedMktQuote.type },
          },
        })}\n`);
      } catch (e) {
        fs.appendFileSync(OUT, `${JSON.stringify({ at: new Date().toISOString(), sym: s, error: String(e.message) })}\n`);
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    last = ph;
  }
  await new Promise((r) => setTimeout(r, 5 * 60e3));
}
