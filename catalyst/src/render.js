/**
 * Pure functions: state -> HTML string. No DOM access, no side effects.
 *
 * The markup here is byte-identical to what the inline boot script in
 * newtab.html produces for the same model. newtab.js re-renders on hydration
 * and only writes to the DOM when the strings actually differ, so the common
 * case is a no-op and drift between the two renderers self-heals.
 */

export const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const TYPE_LABEL = { earnings: 'Earnings', exdiv: 'Ex-dividend', lockup: 'Lockup expiry' };
const TIMING_LABEL = { amc: 'after close', bmo: 'before open', dmt: 'during market' };

/** "est. $2.41" / "est. -$0.51". Uses a real minus sign, not a hyphen. */
export function epsLabel(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '';
  return ` &middot; est. ${v < 0 ? '&minus;' : ''}$${Math.abs(v).toFixed(2)}`;
}
const CAP = 8;
const SOON_DAYS = 5;
const IMMINENT_DAYS = 1;   // today or tomorrow — the rows that must not be missed
const REPORTED_DAYS = 4;   // how long a reported quarter stays on screen
const REPORTED_CAP = 3;

/** "beat 6.2%" / "missed 18.6%" / "in line". */
/**
 * A percentage on a near-zero estimate is noise dressed as signal: CrowdStrike's
 * 4-cent miss against a $0.05 estimate read "missed 80%", and MongoDB's 46-cent
 * beat read "beat 575%". Below a dime of consensus, or past a 100% swing, state
 * the size of the surprise in money instead.
 */
export function surpriseLabel(pct, actual, consensus) {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return null;
  const a = Math.abs(pct);
  if (a < 0.05) return { text: 'in line', dir: 'f' };
  const verb = pct > 0 ? 'beat' : 'missed';
  const dir = pct > 0 ? 'u' : 'd';
  if (typeof actual === 'number' && typeof consensus === 'number' && (Math.abs(consensus) < 0.1 || a >= 100)) {
    return { text: `${verb} by $${Math.abs(actual - consensus).toFixed(2)}`, dir };
  }
  return { text: `${verb} ${a.toFixed(1)}%`, dir };
}

/** Signed dollars with a real minus: -0.45 -> "&minus;$0.45", never "$-0.45". */
export function signedMoney(v) {
  return `${v < 0 ? '&minus;' : ''}$${Math.abs(v).toFixed(2)}`;
}

/** Zacks' EPS basis varies by company and can differ from the headline number. */
export const EPS_BASIS_NOTE = 'Zacks EPS and consensus; may differ from the company&rsquo;s adjusted figure';

/** "today" / "yesterday" / "3 days ago" for an event already in the past. */
export function pastLabel(n) {
  if (n === 0) return 'today';
  if (n === -1) return 'yesterday';
  return `${-n} days ago`;
}

const INSIDER_CAP = 4;

export const SECTION_INSIDERS =
  '<h2 class="shd"><svg class="shi" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" '
  + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>Insider buying</h2>';

/** Compact money: $10.0M / $999K / $60K */
export function money(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '';
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${Math.round(v / 1e3)}K`;
  return `$${Math.round(v)}`;
}

/**
 * Notable open-market purchases only — the provider has already discarded the
 * mechanical majority. Renders nothing at all when there is nothing to say, so
 * a quiet watchlist costs no vertical space.
 */
/**
 * Where an insider purchase can be checked: the SEC's own full-text search for
 * that person's Form 4 at that company, filed within ten days of the trade
 * (Form 4s are due within two business days).
 *
 * Nasdaq supplies no filing ID, and its insider IDs are not SEC CIKs (0 of 79
 * matched), so the link is built from what every Form 4 contains: the filer's
 * name and the company's ticker. Checked against known filings it landed on
 * exactly the filing in 5 of 6 cases, and on that filing plus one other by the
 * same person in the sixth.
 *
 * `who` is Nasdaq's "Last First Middle"; `date` is m/d/yyyy (ISO also accepted).
 */
export function secFilingUrl(sym, who, date) {
  const surname = String(who || '').trim().split(/\s+/)[0].replace(/[.,;]+$/, '');
  const q = surname ? `"${surname}" "${sym}"` : `"${sym}"`;
  const d = String(date || '').trim();
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(d);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  const start = us ? Date.UTC(+us[3], +us[1] - 1, +us[2]) : iso ? Date.UTC(+iso[1], +iso[2] - 1, +iso[3]) : null;
  const day = (t) => new Date(t).toISOString().slice(0, 10);
  const range = start == null ? '' : `&dateRange=custom&startdt=${day(start)}&enddt=${day(start + 864e6)}`;
  return `https://www.sec.gov/edgar/search/#/q=${encodeURIComponent(q)}${range}&forms=4`;
}

export function renderInsiders(symbols, insiders) {
  const data = insiders.data || {};
  const flat = [];
  for (const s of symbols) for (const h of (data[s] || [])) flat.push({ s, ...h });
  if (!flat.length) return '';
  flat.sort((a, b) => b.value - a.value || (a.s < b.s ? -1 : 1));

  let rows = '';
  let idx = 0;
  for (const h of flat.slice(0, INSIDER_CAP)) {
    // No stake figure. Nasdaq's "shares held" is for whichever account the
    // purchase went through, so the percentage cannot be stated honestly:
    // Oracle director Stephen Rusckowski bought 25,000 shares through his living
    // trust (SEC Form 4, 29 Sep 2026), which read "+6410.3%" because the trust
    // went from 390 to 25,390 shares — while he held 60 directly. Who, role and
    // value are what the filings verify exactly; the stake still informs whether
    // a buy is notable, but is never shown as a fact.
    const stake = '';
    const role = h.role ? ` &middot; ${esc(h.role)}` : '';
    rows += `<li class="row buy anim" style="--i:${idx++}">`
      + `<span class="sym">${esc(h.s)}</span>`
      + `<span class="evt">${esc(h.who)}${role}${stake}</span>`
      + `<span class="rel u">${money(h.value)}</span>`
      // The whole row opens the filing; an overlay keeps the layout untouched.
      + `<a class="rlink" href="${esc(secFilingUrl(h.s, h.who, h.date))}" target="_blank" rel="noreferrer noopener"`
      + ` title="View the SEC filing" aria-label="View SEC filing: ${esc(h.who)}, ${esc(h.s)}"></a></li>`;
  }
  return `${SECTION_INSIDERS}<div class="grp"><ul class="rows">${rows}</ul></div>`;
}

export const SECTION_EARNINGS =
  '<h2 class="shd"><svg class="shi" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M8 3v4M16 3v4M3 10.5h18"/></svg>Earnings calendar</h2>';

export function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** Day index in the viewer's local calendar. DST-proof. */
export function dayNumber(y, m, d) { return Math.floor(Date.UTC(y, m, d) / 86400000); }
export function todayNumber(now = new Date()) { return dayNumber(now.getFullYear(), now.getMonth(), now.getDate()); }
export function isoDayNumber(iso) { const p = iso.split('-'); return dayNumber(+p[0], +p[1] - 1, +p[2]); }

/**
 * `confirmed === false` marks a projected date with "~". A projection is a guess
 * from past reporting dates and can move by a week once the company announces
 * the real one, so it must never read with the same certainty as a scheduled
 * event.
 */
export function relativeLabel(n, confirmed = true) {
  if (n < 0) return 'past';
  const t = confirmed ? '' : '~';
  if (n === 0) return `${t}today`;
  if (n === 1) return `${t}tomorrow`;
  return `in ${t}${n} days`;
}

/** Legend for "~", shown only when a projected date is actually on screen. */
export const PROJECTED_NOTE = '<p class="fn anim">~ Projected from past reporting dates, so likely to move.</p>';

export function formatDate(now = new Date()) {
  return `${DAYS[now.getDay()]}, ${MONTHS[now.getMonth()]} ${now.getDate()}`;
}

/** Flatten symbols x catalysts into a sorted, day-indexed list. */
export function buildItems(symbols, catalystData, now = new Date(), results = {}) {
  const today = todayNumber(now);
  const items = [];
  for (const s of symbols) {
    const list = catalystData[s];
    if (!Array.isArray(list)) continue;
    for (const ev of list) {
      if (!ev || !ev.date) continue;
      const n = isoDayNumber(ev.date) - today;
      if (n > 400) continue;
      // A past date is only shown once we actually hold the numbers. That makes
      // "reported" unambiguous without guessing at before-open vs after-close.
      const res = results[s];
      if (n <= 0 && res) { items.push({ s, n, t: ev.type, res, reported: true }); continue; }
      if (n < 0) continue;
      items.push({ s, n, t: ev.type, tm: ev.timing, eps: ev.epsEstimate, cf: ev.confirmed === true });
    }
  }
  items.sort((a, b) => a.n - b.n || (a.s < b.s ? -1 : 1));
  return items;
}

/** Week runs Monday-Sunday, matching how people talk about the trading week. */
export function groupItems(items, now = new Date()) {
  const dow = now.getDay();
  const endThis = dow === 0 ? 0 : 7 - dow;
  const groups = [[], [], []];
  for (const it of items) groups[it.n <= endThis ? 0 : it.n <= endThis + 7 ? 1 : 2].push(it);
  return groups;
}

/**
 * The whole "Coming up" column: insider buying (when there is any) above the
 * earnings calendar. Kept in one function so both renderers have a single
 * insertion point to stay in parity on.
 */
export function renderUpper(symbols, catalysts, now, results, insiders, opts = {}) {
  const showIns = opts.showInsiders !== false;
  const showCat = opts.showCatalysts !== false;
  return (showIns && insiders ? renderInsiders(symbols, insiders) : '')
    + (showCat ? renderComingUp(symbols, catalysts, now, results) : '');
}

export function renderComingUp(symbols, catalysts, now = new Date(), results = { data: {} }) {
  const all = buildItems(symbols, catalysts.data || {}, now, results.data || {});
  const reported = all.filter((i) => i.reported).slice(-REPORTED_CAP).reverse();
  const items = all.filter((i) => !i.reported);
  const hasFetched = Boolean(catalysts.fetchedAt);

  // Tried and failed with nothing cached: say so instead of spinning forever.
  if (!hasFetched && catalysts.stale) return NO_DATA_STATE;

  if (!hasFetched && !items.length && !reported.length) {
    let sk = '';
    for (let k = 0; k < 4; k++) {
      sk += '<li class="row sk"><span class="skb w1"></span><span class="skb w2"></span><span class="skb w3"></span></li>';
    }
    return `${SECTION_EARNINGS}<div class="grp"><h3 class="ghd">Next up</h3><ul class="rows">${sk}</ul></div>`;
  }
  if (!items.length && !reported.length) {
    // Not "nothing scheduled in the next 90 days": the source only publishes a
    // few weeks ahead, and a company it has no date for may well be reporting.
    return `${SECTION_EARNINGS}<div class="grp anim"><h3 class="ghd">Next up</h3>`
      + '<ul class="rows"><li class="more">No upcoming earnings dates published yet.</li></ul></div>';
  }

  const groups = groupItems(items, now);
  const names = ['This week', 'Next week', 'Later'];
  let html = SECTION_EARNINGS, shown = 0, idx = 0, projected = false;

  // What just happened leads: on an earnings morning it is the most relevant
  // thing on the page.
  if (reported.length) {
    let rows = '';
    for (const o of reported) {
      const sp = surpriseLabel(o.res.surprisePct, o.res.actual, o.res.consensus);
      const detail = `EPS ${signedMoney(o.res.actual)} vs ${signedMoney(o.res.consensus)} est.`;
      rows += `<li class="row rep anim" style="--i:${idx++}" title="${EPS_BASIS_NOTE}">`
        + `<span class="sym">${esc(o.s)}</span>`
        + `<span class="evt">${pastLabel(o.n)}<span class="tm"> &middot; ${detail}</span></span>`
        + `<span class="rel ${sp ? sp.dir : 'f'}">${sp ? sp.text : '&mdash;'}</span></li>`;
    }
    html += `<div class="grp"><h3 class="ghd anim" style="--i:${idx++}">Just reported</h3>`
      + `<ul class="rows">${rows}</ul></div>`;
  }

  for (let gi = 0; gi < 3; gi++) {
    if (!groups[gi].length || shown >= CAP) continue;
    const hIdx = idx++;
    let rows = '';
    for (let r = 0; r < groups[gi].length && shown < CAP; r++, shown++) {
      const o = groups[gi][r];
      const detail = (o.tm && TIMING_LABEL[o.tm] ? ` &middot; ${TIMING_LABEL[o.tm]}` : '') + epsLabel(o.eps);
      const tmx = detail ? `<span class="tm">${detail}</span>` : '';
      const heat = o.n <= IMMINENT_DAYS ? ' now' : o.n <= SOON_DAYS ? ' soon' : '';
      const mark = o.n <= IMMINENT_DAYS ? '<span class="pip" aria-hidden="true"></span>' : '';
      if (!o.cf) projected = true;
      rows += `<li class="row anim${heat}" style="--i:${idx++}">`
        + `${mark}<span class="sym">${esc(o.s)}</span><span class="evt">${TYPE_LABEL[o.t] || 'Event'}${tmx}</span>`
        + (o.cf
          ? `<span class="rel">${relativeLabel(o.n)}</span></li>`
          : `<span class="rel est" title="Projected from past reporting dates">${relativeLabel(o.n, false)}`
            + '<span class="vh"> (projected from past reporting dates)</span></span></li>');
    }
    html += `<div class="grp"><h3 class="ghd anim" style="--i:${hIdx}">${names[gi]}</h3><ul class="rows">${rows}</ul></div>`;
  }
  if (items.length > shown) html += `<div class="more anim" style="--i:${idx}">+${items.length - shown} more</div>`;
  if (projected) html += PROJECTED_NOTE;
  return html;
}

/** 0..1 — how close the nearest catalyst is. Drives the ambient wash only. */
export function heatFor(symbols, catalysts, now = new Date()) {
  const items = buildItems(symbols, catalysts.data || {}, now);
  if (!items.length || items[0].n > 7) return 0;
  return Number(Math.max(0, 1 - items[0].n / 7).toFixed(2));
}

/* ---------------------------------------------------------------- sparkline */

const SPARK_W = 100;
const SPARK_H = 30;

/**
 * Intraday shape as an inline SVG. Scaled with preserveAspectRatio="none" so it
 * fills any card width; strokes use vector-effect so they stay hairline-thin.
 * Returns a fixed-height placeholder when there's no series yet, so the card
 * never changes height when the line arrives.
 */
export function sparkline(points, prevClose, dir) {
  if (!Array.isArray(points) || points.length < 2) return '<div class="sparkph"></div>';
  let min = Infinity;
  let max = -Infinity;
  for (const v of points) { if (v < min) min = v; if (v > max) max = v; }
  if (prevClose != null) { if (prevClose < min) min = prevClose; if (prevClose > max) max = prevClose; }
  const span = (max - min) || 1;
  const pad = 2;
  const y = (v) => (SPARK_H - pad - ((v - min) / span) * (SPARK_H - pad * 2)).toFixed(1);
  const step = SPARK_W / (points.length - 1);
  let d = '';
  for (let i = 0; i < points.length; i++) d += `${i ? 'L' : 'M'}${(i * step).toFixed(1)} ${y(points[i])}`;
  const base = prevClose == null ? ''
    : `<line class="spb" x1="0" y1="${y(prevClose)}" x2="${SPARK_W}" y2="${y(prevClose)}"/>`;
  return `<svg class="spark ${dir}" viewBox="0 0 ${SPARK_W} ${SPARK_H}" preserveAspectRatio="none" aria-hidden="true">`
    + `${base}<path class="spf" d="${d}L${SPARK_W} ${SPARK_H}L0 ${SPARK_H}Z"/>`
    + `<path class="spl" d="${d}"/></svg>`;
}

/* ----------------------------------------------------------------- holdings */

/** Deterministic hue per ticker, so a monogram is stable across sessions. */
export function logoHue(sym) {
  let h = 0;
  for (let i = 0; i < sym.length; i++) h = (h * 31 + sym.charCodeAt(i)) % 360;
  return h;
}

/**
 * A cached logo if we have one, otherwise a monogram. Coverage genuinely has
 * holes, and a generated mark reads as intentional where a broken image would
 * not. Both occupy the same 18px box, so the swap can't shift anything.
 */
/**
 * Nasdaq names securities, not companies: "Keurig Dr Pepper Inc. Common Stock",
 * "Lennar Corporation Class A Common Stock". On a card that truncates to
 * "Keurig Dr Pepper Inc. Com…". Strip the security type, and only when it is the
 * whole tail, so "Stockholm Capital Shares Fund" stays intact.
 */
export function cleanName(n) {
  const raw = String(n || '');
  const s = raw
    .replace(/\s+(?:Class\s+[A-Z]\s+)?(?:New\s+)?(?:Common|Ordinary|Capital|Subordinate\s+Voting)\s+(?:Stock|Shares)(?:\s*\([^)]*\))?\s*$/i, '')
    .replace(/\s+American\s+Depositary\s+(?:Shares?|Receipts?)(?:\s*\([^)]*\))?\s*$/i, '')
    .trim();
  return s || raw;
}

export function logoMark(sym, info) {
  const src = info && typeof info.logo === 'string' && info.logo.startsWith('data:image/')
    ? info.logo : null;
  return src
    ? `<img class="clogo" src="${src}" alt="" width="18" height="18">`
    : `<span class="clogo mono" style="--h:${logoHue(sym)}">${esc(sym.slice(0, 2))}</span>`;
}

export const MAX_SYMBOLS = 25;

export const ADD_CARD =
  '<button class="cell add" id="addcard" aria-label="Add a stock">'
  + '<span class="addg">+</span><span class="addt">Add stock</span></button>';

/** At the cap, the add affordance becomes an explanation instead of a dead button. */
export const ADD_CARD_FULL =
  '<div class="cell add off" aria-disabled="true"><span class="addt">25 ticker limit</span></div>';

/**
 * meta[sym].exchange is already stored as a Google Finance venue slug.
 * A bare /finance/quote/SYM without an exchange does NOT resolve to a quote
 * page (it lands on the Google Finance home page), so fall back to search.
 */
export function gfUrl(sym, exchange) {
  return exchange
    ? `https://www.google.com/finance/quote/${encodeURIComponent(sym)}:${exchange}`
    : `https://www.google.com/search?q=${encodeURIComponent(sym)}+stock`;
}

/** An in-flight fetch ages out, so a worker killed mid-request can't strand a
 *  card on "Fetching..." forever. */
export const FETCH_WINDOW_MS = 30000;
export function isFetching(quotes, now = Date.now()) {
  return Boolean(quotes.fetchingSince) && now - quotes.fetchingSince < FETCH_WINDOW_MS;
}

/**
 * Display order. Symbols with no quote always sink to the bottom regardless of
 * direction — a pending card shouldn't win "top mover".
 */
export function sortSymbols(symbols, quotes, meta = {}, sort) {
  const by = sort && sort.by === 'name' ? 'name' : 'change';
  const dir = sort && sort.dir === 'asc' ? 1 : -1;   // asc: A-Z / low-high
  const data = quotes.data || {};
  return [...symbols].sort((a, b) => {
    const da = data[a];
    const db = data[b];
    const ha = da && da.price != null ? 0 : 1;
    const hb = db && db.price != null ? 0 : 1;
    if (ha !== hb) return ha - hb;
    if (by === 'name') {
      const na = ((meta[a] && meta[a].name) || a).toLowerCase();
      const nb = ((meta[b] && meta[b].name) || b).toLowerCase();
      if (na !== nb) return (na < nb ? -1 : 1) * dir;
    } else {
      const ca = da && typeof da.changePct === 'number' ? da.changePct : -Infinity;
      const cb = db && typeof db.changePct === 'number' ? db.changePct : -Infinity;
      if (ca !== cb) return (ca - cb) * dir;
    }
    return a < b ? -1 : 1;                            // stable tiebreak
  });
}

/** Rendered on every card, or none, so heights stay uniform within a session. */
export function extLine(d, phase) {
  const label = phase === 'pre' ? 'Pre' : 'AH';
  const e = d && d.ext;
  if (!e || e.price == null) return `<span class="cext"><em>${label}</em>&mdash;</span>`;
  const dir = e.changePct > 0 ? 'u' : e.changePct < 0 ? 'd' : 'f';
  const sign = e.changePct > 0 ? '+' : '';
  return `<span class="cext"><em>${label}</em>${e.price.toFixed(2)}`
    + ` <b class="${dir}">${sign}${e.changePct.toFixed(2)}%</b></span>`;
}

export function renderHoldings(symbols, quotes, series = { data: {} }, meta = {}, now = Date.now(), sort) {
  const pending = isFetching(quotes, now) || !quotes.fetchedAt;
  const data0 = quotes.data || {};
  const anyExt = symbols.some((s) => data0[s] && data0[s].ext);
  let html = '';
  for (const s of sortSymbols(symbols, quotes, meta, sort)) {
    const d = (quotes.data || {})[s];
    const info = meta[s] || {};
    const actions = '<span class="cact">'
      + `<a class="ca gf" href="${gfUrl(s, info.exchange)}" target="_blank" rel="noreferrer noopener"`
      + ` aria-label="Open ${esc(s)} in Google Finance" title="Google Finance">&#8599;</a>`
      + `<button class="ca" data-rm="${esc(s)}" aria-label="Remove ${esc(s)}" title="Remove">&times;</button>`
      + '</span>';

    if (!d || d.price == null) {
      // Three distinct states, never conflated: fetching now, nothing to show,
      // or waiting on the very first fetch.
      html += pending
        ? `<div class="cell sk" data-s="${esc(s)}"><div class="chd">${logoMark(s, info)}<span class="csym">${esc(s)}</span>${actions}</div>`
          + `<span class="cnm">${esc(cleanName(info.name))}</span><span class="cpx skl"><i class="skb"></i></span>`
          + '<span class="cch pend">Fetching&hellip;</span><div class="sparkph"></div></div>'
        : `<div class="cell nod" data-s="${esc(s)}"><div class="chd">${logoMark(s, info)}<span class="csym">${esc(s)}</span>${actions}</div>`
          + `<span class="cnm">${esc(cleanName(info.name))}</span><span class="cpx">&mdash;</span>`
          + `<span class="cch">${(quotes.unknown || {})[s] ? 'Not a ticker' : 'No data'}</span>`
          + '<div class="sparkph"></div></div>';
      continue;
    }
    const cp = d.changePct;
    const dir = cp > 0 ? 'u' : cp < 0 ? 'd' : 'f';
    const sign = cp > 0 ? '+' : '';
    const net = d.prevClose == null ? null : d.price - d.prevClose;
    const netStr = net == null ? '' : `<span class="cnet">(${net > 0 ? '+' : ''}${net.toFixed(2)})</span> `;
    const name = info.name ? `<span class="cnm">${esc(cleanName(info.name))}</span>` : '<span class="cnm"></span>';
    html += `<div class="cell" data-s="${esc(s)}"><div class="chd">${logoMark(s, info)}<span class="csym">${esc(s)}</span>${actions}</div>`
      + `${name}<span class="cpx">${d.price.toFixed(2)}</span>`
      + `<span class="cch ${dir}">${netStr}${cp == null ? '&mdash;' : `${sign}${cp.toFixed(2)}%`}</span>`
      + (anyExt ? extLine(d, quotes.extPhase) : '')
      + `${sparkline((series.data || {})[s], d.prevClose, dir)}</div>`;
  }
  return html + (symbols.length >= MAX_SYMBOLS ? ADD_CARD_FULL : ADD_CARD);
}

export function renderFooter(quotes, catalysts, now = Date.now()) {
  const busy = isFetching(quotes, now);
  const at = quotes.fetchedAt || catalysts.fetchedAt || 0;
  // Never replace the timestamp with a bare "Updating…" — a refresh that is
  // merely slow then reads as a stuck UI. Append it instead, so the last known
  // good time is always on screen.
  if (!at) return busy ? 'Updating\u2026' : '';
  const mn = Math.floor((now - at) / 60000);
  const ago = mn < 1 ? 'just now'
    : mn < 60 ? `${mn} min ago`
      : mn < 1440 ? `${Math.floor(mn / 60)} hr ago`
        : `${Math.floor(mn / 1440)} d ago`;
  if (!(quotes.stale || catalysts.stale)) return `Updated ${ago}${busy ? ' · updating' : ''}`;
  const why = quotes.reason === 'rate' ? 'rate limited'
    : quotes.reason === 'auth' ? 'key rejected'
      : quotes.reason === 'blocked' ? 'data source unavailable'
        : 'offline';
  return `Updated ${ago} · ${why}`;
}

export const NO_DATA_STATE =
  `${SECTION_EARNINGS}<div class="grp anim"><h3 class="ghd">Next up</h3><ul class="rows">`
  + '<li class="more">Couldn&rsquo;t load earnings dates &mdash; check your API key in settings.</li>'
  + '</ul></div>';

export const ALL_HIDDEN =
  '<div class="grp anim"><p class="more">Both sections are hidden &mdash; open settings to turn one back on.</p></div>';

export const EMPTY_STATE =
  '<div class="empty anim"><h1>What&rsquo;s coming up</h1>'
  + '<p>Passive Investment Analyst shows earnings dates for the stocks you track, every time you open a tab. '
  + 'Add a few tickers to get started &mdash; no account needed.</p>'
  + '<button class="btn" id="setup">Add your first stock</button></div>';
