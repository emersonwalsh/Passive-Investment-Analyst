/**
 * Hydration. The page has already painted from the localStorage mirror by the
 * time this runs, so nothing here is allowed to be urgent.
 *
 * Update strategy:
 *   - quotes only (every 15 min)  -> patch text nodes in place, zero reflow
 *   - structural (symbols/dates)  -> re-render, but only if the markup differs
 */

import { provider } from './providers/index.js';
import {
  getState, patch, addSymbol, removeSymbol, normalizeSymbol, MAX_SYMBOLS,
} from './store.js';
import { readCache, writeCache } from './cache-bridge.js';
import { marketPhase, PHASE_LABEL } from './market-hours.js';
import {
  renderUpper, renderHoldings, renderFooter, heatFor, formatDate,
  EMPTY_STATE, ALL_HIDDEN, esc, extLine, isFetching, FETCH_WINDOW_MS,
} from './render.js';

const $ = (id) => document.getElementById(id);
/** The worker may still be spinning up; a dropped nudge is harmless. */
/**
 * `reason` decides how aggressive the worker is allowed to be. Adding a ticker
 * is routine and must stay cheap; only a deliberate act ('user' or 'key') may
 * clear a backoff or force the expensive calendar scan.
 */
const send = (type, reason, symbol) => { try { chrome.runtime.sendMessage({ type, reason, symbol })?.catch?.(() => {}); } catch { /* noop */ } };
const el = {
  up: $('up'), hold: $('hold'), holdwrap: $('holdwrap'),
  upd: $('upd'), gear: $('gear'), mkt: $('mkt'), date: $('date'),
};

let state = null;
let painted = { up: null, hold: null, ready: null };
let overlay = null;

/* ---------------------------------------------------------------- boot sync */
// Seed `painted` with what the inline boot script produced, computed from the
// same cached model. Comparing strings avoids innerHTML re-normalisation.
{
  const c = readCache();
  if (c && c.ready) {
    const now = new Date();
    painted.ready = true;
    const showCat = c.showCatalysts !== false;
    const showPx = c.showPrices !== false;
    const upper = renderUpper(c.symbols || [], c.catalysts || { fetchedAt: 0, data: {} }, now,
      c.results || { data: {} }, c.insiders || { data: {} },
      { showCatalysts: showCat, showInsiders: c.showInsiders !== false });
    painted.up = !showCat && !showPx && !upper ? ALL_HIDDEN : (upper || null);
    painted.hold = showPx
      ? renderHoldings(c.symbols || [], c.quotes || { data: {} }, c.series || { data: {} },
        c.meta || {}, Date.now(), c.sort)
      : null;
  } else if (!c) {
    // No mirror: boot deliberately painted nothing (see boot.js), so every
    // region is unknown and the first paint must write whatever storage says.
    painted.ready = null;
    painted.up = '';
    painted.hold = '';
  } else {
    painted.ready = false;
    painted.up = EMPTY_STATE;
  }
}

/* ------------------------------------------------------------------ painting */
function paint(next, { flashQuotes = false } = {}) {
  const now = new Date();
  const ready = Boolean(next.settings.apiKey) || next.symbols.length > 0;

  if (!ready) {
    if (painted.ready !== false) {
      el.up.innerHTML = EMPTY_STATE;
      painted.up = EMPTY_STATE;
      painted.ready = false;
    }
    el.holdwrap.className = 'hide';
    el.upd.textContent = '';
    wireEmptyState();
    return;
  }
  painted.ready = true;

  const showCat = next.settings.showCatalysts !== false;
  const showPx = next.settings.showPrices !== false;

  const upper = renderUpper(next.symbols, next.catalysts, now, next.results, next.insiders,
    { showCatalysts: showCat, showInsiders: next.settings.showInsiders !== false });
  if (!showCat && !showPx && !upper) {
    el.up.className = 'sec';
    if (painted.up !== ALL_HIDDEN) { el.up.innerHTML = ALL_HIDDEN; painted.up = ALL_HIDDEN; }
  } else if (!upper) {
    el.up.className = 'hide';
    painted.up = null;
  } else {
    el.up.className = 'sec';
    if (upper !== painted.up) { el.up.innerHTML = upper; painted.up = upper; }
  }

  if (!showPx) {
    el.holdwrap.className = 'hide';
    painted.hold = null;
  } else {
    el.holdwrap.className = '';
    const hold = renderHoldings(next.symbols, next.quotes, next.series, next.meta,
      Date.now(), next.settings.sort);
    if (hold !== painted.hold) {
      // Same set of cells? Patch text only — never re-create the grid.
      if (painted.hold && flashQuotes && sameCells(painted.hold, hold)) patchQuotes(next);
      else if (el.hold.firstElementChild) reconcileHold(hold);
      else el.hold.innerHTML = hold;
      painted.hold = hold;
    }
  }

  el.upd.textContent = renderFooter(next.quotes, next.catalysts, Date.now());
  syncSortLabel();
  schedulePendingSweep(next);
  document.body.style.setProperty('--heat', String(heatFor(next.symbols, next.catalysts, now)));
}

/**
 * The pending state ages out by time, but nothing re-renders when it does — so
 * a card whose fetch never reported back would sit on "Fetching…" forever.
 * Re-paint exactly once, when the window lapses.
 */
let pendingTimer = null;
function schedulePendingSweep(next) {
  clearTimeout(pendingTimer);
  if (!isFetching(next.quotes, Date.now())) return;
  const remaining = FETCH_WINDOW_MS - (Date.now() - next.quotes.fetchingSince);
  pendingTimer = setTimeout(() => { if (state) paint(state); }, Math.max(500, remaining + 250));
}

/** Cheap structural check: same symbols, in the same order, all with data. */
function sameCells(a, b) {
  const ids = (s) => (s.match(/data-s="[^"]*"/g) || []).join('|');  // order-sensitive
  const skel = (s) => (s.match(/cell sk/g) || []).length;
  // The extended-hours line appears and disappears at session boundaries, which
  // changes card structure. Patching text in place can't create it, so treat a
  // change in its presence as structural and force a full re-render.
  const ext = (s) => (s.match(/class="cext"/g) || []).length;
  return ids(a) === ids(b) && skel(a) === skel(b) && ext(a) === ext(b);
}

/**
 * Bring #hold in line with `html` while keeping every node that did not change.
 *
 * Replacing the grid's innerHTML on every background update — a sparkline, a
 * logo, a company name learned — destroyed and re-created every card. Measured
 * in real Chrome: a click on a card's remove button that straddled such an
 * update never fired at all, and keyboard focus on a card fell back to <body>.
 * It also replayed the cards' entrance animation. Cards are now matched by
 * ticker and morphed in place, so a button being pressed or focused is the same
 * element before and after, and only cards that changed position are moved.
 */
const TRANSIENT_ATTRS = new Set(['data-k']);    // written by patchQuotes, not by the renderer
const TRANSIENT_CLASSES = ['fl'];               // a quote flash still playing

function syncAttrs(a, b) {
  // patchQuotes' data-k records which price an element shows. If this morph
  // changes that content, the record is stale; keeping it could make a later
  // patch skip a real change and leave a wrong price on screen.
  const sameContent = a.textContent === b.textContent;
  for (const { name } of [...a.attributes]) {
    if (!b.hasAttribute(name) && !(TRANSIENT_ATTRS.has(name) && sameContent)) a.removeAttribute(name);
  }
  for (const { name, value } of [...b.attributes]) {
    let v = value;
    if (name === 'class') {
      const keep = TRANSIENT_CLASSES.filter((c) => a.classList.contains(c));
      if (keep.length) v = `${value} ${keep.join(' ')}`;
    }
    if (a.getAttribute(name) !== v) a.setAttribute(name, v);
  }
}

function morph(a, b) {
  syncAttrs(a, b);
  const ac = [...a.childNodes];
  const bc = [...b.childNodes];
  for (let i = 0; i < bc.length; i++) {
    const x = ac[i];
    const y = bc[i];
    if (!x) { a.appendChild(y); continue; }
    if (x.nodeType !== y.nodeType || x.nodeName !== y.nodeName) { x.replaceWith(y); continue; }
    if (x.nodeType === Node.TEXT_NODE) { if (x.nodeValue !== y.nodeValue) x.nodeValue = y.nodeValue; continue; }
    if (x.nodeType === Node.ELEMENT_NODE) morph(x, y);
  }
  for (let i = bc.length; i < ac.length; i++) ac[i].remove();
}

function reconcileHold(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const want = [...tpl.content.children];
  const keyOf = (n) => n.getAttribute('data-s') || `${n.nodeName}#${n.id}.${n.className}`;
  const wanted = new Set(want.map(keyOf));
  // Drop what is no longer shown first, so it cannot sit in a slot and force
  // every card after it to be moved.
  const have = new Map();
  for (const n of [...el.hold.children]) {
    const k = keyOf(n);
    if (wanted.has(k) && !have.has(k)) have.set(k, n); else n.remove();
  }
  let slot = el.hold.firstElementChild;
  for (const w of want) {
    const existing = have.get(keyOf(w));
    let node = w;
    if (existing && existing.nodeName === w.nodeName) { morph(existing, w); node = existing; }
    else if (existing) {
      if (existing === slot) slot = slot.nextElementSibling;   // never insert before a detached node
      existing.remove();
    }
    if (node === slot) slot = slot.nextElementSibling;
    else el.hold.insertBefore(node, slot);         // moves only what is out of place
  }
}

function patchQuotes(next) {
  for (const cell of el.hold.querySelectorAll('.cell[data-s]')) {
    const d = next.quotes.data[cell.dataset.s];
    if (!d || d.price == null) continue;
    const px = cell.querySelector('.cpx');
    const ch = cell.querySelector('.cch');
    if (!px || !ch) continue;                  // still a skeleton card
    const cp = d.changePct;
    const dir = cp > 0 ? 'u' : cp < 0 ? 'd' : 'f';
    const nextPx = d.price.toFixed(2);
    // the extended-hours figure refreshes on the same cycle, so it belongs in
    // the change key — otherwise this fast path leaves it stale
    const ex = d.ext ? `${d.ext.price}|${d.ext.changePct}` : '';
    const key = `${nextPx}|${cp}|${ex}`;
    if (ch.dataset.k === key) continue;
    ch.dataset.k = key;
    const net = d.prevClose == null ? null : d.price - d.prevClose;
    px.textContent = nextPx;
    ch.className = `cch ${dir}`;
    ch.innerHTML = (net == null ? '' : `<span class="cnet">(${net > 0 ? '+' : ''}${net.toFixed(2)})</span> `)
      + (cp == null ? '—' : `${cp > 0 ? '+' : ''}${cp.toFixed(2)}%`);
    const sp = cell.querySelector('.spark');
    if (sp) sp.setAttribute('class', `spark ${dir}`);
    const cx = cell.querySelector('.cext');
    if (cx) cx.outerHTML = extLine(d, next.quotes.extPhase);
    cell.classList.remove('fl');
    void cell.offsetWidth; // restart the flash
    cell.classList.add('fl');
  }
}

function paintClock() {
  const phase = marketPhase();
  const cls = phase === 'open' ? 'open' : phase === 'closed' ? '' : 'ext';
  el.mkt.className = `pill ${cls}`;
  el.mkt.innerHTML = `<span class="dot"></span>${PHASE_LABEL[phase]}`;
  el.date.textContent = formatDate(new Date());
  if (state) el.upd.textContent = renderFooter(state.quotes, state.catalysts, Date.now());
}

/* ------------------------------------------------------------------- wiring */
function wireEmptyState() {
  const b = $('setup');
  if (!b || b.dataset.wired) return;
  b.dataset.wired = '1';
  b.addEventListener('click', () => openSearch());
}

async function hydrate() {
  state = await getState();
  paint(state);
  writeCache(state);
  wireEmptyState();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const keys = Object.keys(changes).filter((k) => k !== 'diag'); // diagnostics aren't UI state
    if (!keys.length) return;
    const onlyQuotes = keys.length === 1 && keys[0] === 'quotes';
    getState().then((s) => {
      state = s;
      paint(s, { flashQuotes: onlyQuotes });
      writeCache(s);
      if (overlay) overlay._sync?.();
    });
  });

  send('wake');
  loadSettingsCss();   // tiny, non-blocking; keeps the overlays flash-free

  // Long-lived tabs: keep the market pill, the date and "updated N ago" honest.
  setInterval(paintClock, 60000);
}


/**
 * Focus without relying on requestAnimationFrame: rAF never fires while a tab
 * is hidden, and Chrome renders the new tab page in the background. Focusing
 * directly works as soon as the element is displayed; the retries only cover
 * the case where layout hasn't settled.
 */
function focusNow(node) {
  if (!node) return;
  node.focus();
  if (document.activeElement === node) return;
  setTimeout(() => {
    if (document.activeElement !== node) node.focus();
  }, 0);
}


/* ----------------------------------------------------------------- sorting */
const SORT_FIELDS = [['change', '% change'], ['name', 'Name']];
let smenu = null;

function currentSort() {
  const s = state?.settings?.sort;
  return { by: s?.by === 'name' ? 'name' : 'change', dir: s?.dir === 'asc' ? 'asc' : 'desc' };
}

function syncSortLabel() {
  const { by, dir } = currentSort();
  const lbl = $('sortlbl');
  const car = $('sortdir');
  if (lbl) lbl.textContent = SORT_FIELDS.find(([k]) => k === by)[1];
  if (car) car.textContent = dir === 'asc' ? '\u2191' : '\u2193';
  if (smenu) {
    for (const b of smenu.querySelectorAll('[data-by]')) {
      const on = b.dataset.by === by;
      b.setAttribute('aria-checked', String(on));
      b.querySelector('.tick').textContent = on ? '\u2713' : '';
    }
    const d = smenu.querySelector('.dirbtn');
    if (d) d.textContent = dir === 'asc' ? 'Reverse \u2014 currently ascending' : 'Reverse \u2014 currently descending';
  }
}

async function setSort(next) {
  await patch({ settings: { ...state.settings, sort: { ...currentSort(), ...next } } });
}

function buildSortMenu() {
  const m = document.createElement('div');
  m.className = 'smenu';
  m.id = 'smenu';
  m.setAttribute('role', 'menu');
  m.innerHTML = SORT_FIELDS.map(([k, label]) =>
    `<button role="menuitemradio" aria-checked="false" data-by="${k}">${label}<span class="tick"></span></button>`).join('')
    + '<div class="sdiv"></div>'
    + '<button role="menuitem" class="dirbtn" data-dir="toggle"></button>';
  document.querySelector('.sechd').appendChild(m);

  m.addEventListener('click', async (e) => {
    const f = e.target.closest('[data-by]');
    const d = e.target.closest('[data-dir]');
    if (f) {
      // clicking the active field flips direction, which is the usual convention
      const cur = currentSort();
      await setSort(cur.by === f.dataset.by
        ? { dir: cur.dir === 'asc' ? 'desc' : 'asc' }
        : { by: f.dataset.by });
    } else if (d) {
      await setSort({ dir: currentSort().dir === 'asc' ? 'desc' : 'asc' });
    } else return;
    closeSortMenu();
  });
  return m;
}

function openSortMenu() {
  if (!smenu) smenu = buildSortMenu();
  syncSortLabel();
  smenu.classList.add('on');
  $('sortbtn').setAttribute('aria-expanded', 'true');
  document.addEventListener('click', onSortOutside, true);
  document.addEventListener('keydown', onSortKeys, true);
}

function closeSortMenu() {
  if (!smenu) return;
  smenu.classList.remove('on');
  $('sortbtn')?.setAttribute('aria-expanded', 'false');
  document.removeEventListener('click', onSortOutside, true);
  document.removeEventListener('keydown', onSortKeys, true);
}

function onSortOutside(e) {
  if (!e.target.closest('#smenu') && !e.target.closest('#sortbtn')) closeSortMenu();
}
function onSortKeys(e) {
  if (e.key === 'Escape') { e.preventDefault(); closeSortMenu(); $('sortbtn')?.focus(); }
}

$('sortbtn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  if (smenu?.classList.contains('on')) closeSortMenu();
  else openSortMenu();
});

/* --------------------------------------------------------------- search box */
let lastFocus = null;   // shared by the search and settings overlays
let sov = null;
let sResults = [];
let sActive = -1;
let sTimer = null;
let sSeq = 0;

function buildSearch() {
  const w = document.createElement('div');
  w.className = 'ov sov';
  w.innerHTML = `
    <div class="ovbd" data-close></div>
    <div class="sp" role="dialog" aria-modal="true" aria-label="Add a stock">
      <input class="si" id="si" placeholder="Search company or ticker&hellip;" spellcheck="false"
             autocomplete="off" role="combobox" aria-expanded="false" aria-controls="sres"
             aria-autocomplete="list" aria-label="Search company or ticker">
      <ul class="sres" id="sres" role="listbox" aria-label="Search results"></ul>
      <p class="smsg" id="smsg" role="status" aria-live="polite"></p>
    </div>`;
  document.body.appendChild(w);

  w.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) return closeSearch();
    const row = e.target.closest('[data-i]');
    if (row) pick(Number(row.dataset.i));
  });

  const si = w.querySelector('#si');
  si.addEventListener('input', () => {
    clearTimeout(sTimer);
    const q = si.value.trim();
    if (!q) { sResults = []; drawResults(); return setMsg(''); }
    // Drop stale rows immediately: otherwise Enter during an in-flight search
    // can add whatever the previous query matched.
    sResults = [];
    sActive = -1;
    drawResults();
    setMsg('Searching\u2026');
    sTimer = setTimeout(() => runSearch(q), 180);
  });
  si.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); if (sActive >= 0) pick(sActive); }
    else if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
  });
  return w;
}

const setMsg = (t, kind) => {
  const n = sov?.querySelector('#smsg');
  if (n) { n.textContent = t; n.className = `smsg${kind ? ` ${kind}` : ''}`; }
};

/**
 * Search is the only discovery path and it runs on an undocumented endpoint.
 * When it fails or finds nothing, fall back to letting the user add a ticker
 * they already know, so one broken third-party URL can't take out the core flow.
 */
function directEntry(q) {
  const sym = normalizeSymbol(q);
  if (!sym || sym.length > 6) return [];
  return [{ symbol: sym, name: 'Add this ticker directly', exchange: null, kind: null, direct: true }];
}

async function runSearch(q) {
  const seq = ++sSeq;
  try {
    const rows = await provider.searchSymbols(q);
    if (seq !== sSeq) return;                       // a newer keystroke won
    const direct = rows.some((r) => r.symbol === normalizeSymbol(q)) ? [] : directEntry(q);
    sResults = [...rows, ...direct];
    sActive = sResults.length ? 0 : -1;
    drawResults();
    setMsg(rows.length ? '' : (sResults.length ? '' : 'No matches.'));
  } catch {
    if (seq !== sSeq) return;
    sResults = directEntry(q);
    sActive = sResults.length ? 0 : -1;
    drawResults();
    setMsg(sResults.length
      ? "Search is unavailable — you can still add a ticker by symbol."
      : "Couldn't reach search. Check your connection.", 'warn');
  }
}

function drawResults() {
  const list = sov?.querySelector('#sres');
  const si = sov?.querySelector('#si');
  if (!list) return;
  const have = new Set(state?.symbols || []);
  list.innerHTML = sResults.map((r, i) => {
    const owned = have.has(r.symbol);
    return `<li role="option" aria-selected="${i === sActive}" data-i="${i}"`
      + ` class="${i === sActive ? 'on' : ''}${owned ? ' owned' : ''}">`
      + `<span class="rsym">${esc(r.symbol)}</span>`
      + `<span class="rnm${r.direct ? ' rdir' : ''}">${esc(r.name)}</span>`
      + `<span class="rex">${owned ? 'Added' : esc(r.kind || r.exchange || '')}</span></li>`;
  }).join('');
  si?.setAttribute('aria-expanded', String(sResults.length > 0));
}

function move(d) {
  if (!sResults.length) return;
  sActive = (sActive + d + sResults.length) % sResults.length;
  drawResults();
  sov.querySelector('.sres .on')?.scrollIntoView({ block: 'nearest' });
}

async function pick(i) {
  const r = sResults[i];
  if (!r) return;
  if ((state?.symbols || []).includes(r.symbol)) return setMsg(`${r.symbol} is already on your list.`, 'warn');
  if ((state?.symbols || []).length >= MAX_SYMBOLS) return setMsg(`That's the ${MAX_SYMBOLS} ticker limit.`, 'warn');

  // A direct entry is whatever the user typed. Confirm it resolves before
  // saving, or a company name like "NVIDIA" is stored as a ticker and shows
  // "Not a ticker" forever.
  if (r.direct) {
    setMsg(`Checking ${r.symbol}\u2026`, '');
    const verdict = await provider.verifySymbol(r.symbol);
    if (verdict === 'unknown') {
      return setMsg(`${r.symbol} isn't a recognized ticker \u2014 try the symbol rather than `
        + 'the company name (NVIDIA is NVDA, Amazon is AMZN).', 'bad');
    }
    if (verdict === 'error') return setMsg("Couldn't verify that ticker. Try again.", 'bad');
  }

  await addSymbol(r.symbol, r.direct
    ? null                                   // name/exchange backfill on the next series refresh
    : { name: r.name, exchange: provider.googleExchange(r.exchange) });
  send('refresh', 'add', r.symbol);   // name the ticker so the worker fetches only it
  closeSearch();
}

function openSearch() {
  loadSettingsCss();
  if (!sov) sov = buildSearch();
  sResults = [];
  sActive = -1;
  drawResults();
  setMsg('');
  const si = sov.querySelector('#si');
  si.value = '';
  lastFocus = document.activeElement;
  sov.classList.add('on');
  document.addEventListener('keydown', onSearchKeys, true);
  focusNow(si);
}

function closeSearch() {
  if (!sov) return;
  sov.classList.remove('on');
  document.removeEventListener('keydown', onSearchKeys, true);
  restoreFocus(document.getElementById('addcard') || el.gear);
}

function onSearchKeys(e) {
  if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
}

/* ------------------------------------------------------- settings (deferred) */
let cssLoaded = false;
function loadSettingsCss() {
  if (cssLoaded) return;
  cssLoaded = true;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'styles/settings.css';
  link.media = 'print';                       // never blocks paint
  link.onload = () => { link.media = 'all'; };
  document.head.appendChild(link);
}

function buildOverlay() {
  const wrap = document.createElement('div');
  wrap.className = 'ov';
  wrap.id = 'ov';
  wrap.innerHTML = `
    <div class="ovbd" data-close></div>
    <div class="ovp" role="dialog" aria-modal="true" aria-labelledby="ovt">
      <div class="ovh">
        <h2 id="ovt">Settings</h2>
        <button class="x" data-close aria-label="Close settings">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      </div>

      <section class="fld">
        <span class="lbl">Tickers <span class="cnt" id="cnt"></span></span>
        <ul class="tk" id="tk"></ul>
        <button class="addbtn" id="addopen" type="button">+ Add a stock</button>
      </section>

      <section class="fld">
        <label class="lbl" for="key">Finnhub API key <span class="cnt">optional</span></label>
        <input class="in" id="key" type="password" placeholder="Paste your key"
               spellcheck="false" autocomplete="off">
        <p class="msg" id="keyst" role="status" aria-live="polite"></p>
        <p class="msg" id="srcst" role="status" aria-live="polite"></p>
        <p class="hint">Passive Investment Analyst works without a key. Adding one switches quotes and
          earnings to <a href="${provider.signupUrl}" target="_blank" rel="noreferrer noopener">Finnhub</a>,
          an official source with a documented API. Free, no card. Stored only on this device.</p>
      </section>

      <section class="fld">
        <span class="lbl">Sections</span>
        <div class="rows2">
          <div class="rw"><label for="secCat">Earnings calendar</label>
            <button class="sw" id="secCat" role="switch" aria-checked="true"><span class="knob"></span></button></div>
          <div class="rw"><label for="secIns">Insider buying</label>
            <button class="sw" id="secIns" role="switch" aria-checked="true"><span class="knob"></span></button></div>
          <p class="rwhint" id="insHint"></p>
          <div class="rw"><label for="px">Today&rsquo;s movement</label>
            <button class="sw" id="px" role="switch" aria-checked="true"><span class="knob"></span></button></div>
          <div class="rw sub"><label for="secExt">Pre-market &amp; after-hours</label>
            <button class="sw" id="secExt" role="switch" aria-checked="true"><span class="knob"></span></button></div>
          <p class="rwhint sub" id="extHint"></p>
        </div>
      </section>

      <section class="fld inline">
        <span class="lbl">Theme</span>
        <div class="seg" id="thm" role="group" aria-label="Theme">
          <button data-t="auto">Auto</button><button data-t="dark">Dark</button><button data-t="light">Light</button>
        </div>
      </section>

      <p class="about">Prices and insider filings come from Nasdaq; earnings dates and estimates from
        Zacks, and a date can occasionally differ from the company&rsquo;s own announcement. Logos from
        Financial Modeling Prep and Finnhub. Third-party data can be delayed or incomplete. Not
        investment advice.</p>
    </div>`;
  document.body.appendChild(wrap);
  return wrap;
}

function renderTickers() {
  const list = $('tk');
  const cnt = $('cnt');
  if (!list) return;
  list.innerHTML = state.symbols.length
    ? state.symbols.map((s) => `<li><span>${esc(s)}</span>`
      + `<button class="rm" data-rm="${esc(s)}" aria-label="Remove ${esc(s)}">`
      + '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
      + 'stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>'
      + '</button></li>').join('')
    : '<li class="none">No tickers yet</li>';
  cnt.textContent = `${state.symbols.length}/${MAX_SYMBOLS}`;
  const addOpen = $('addopen');
  if (addOpen) {
    const full = state.symbols.length >= MAX_SYMBOLS;
    addOpen.disabled = full;
    addOpen.textContent = full ? `${MAX_SYMBOLS} ticker limit reached` : '+ Add a stock';
  }
}

function msg(node, text, kind) {
  node.textContent = text;
  node.className = `msg${kind ? ` ${kind}` : ''}`;
}

function wireOverlay(wrap) {
  wrap.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) closeSettings();
    const rm = e.target.closest('[data-rm]');
    if (rm) removeSymbol(rm.dataset.rm);
  });

  $('addopen').addEventListener('click', () => {
    closeSettings();
    openSearch();
  });

  const key = $('key');
  const keyst = $('keyst');
  if (state.settings.apiKey) {
    key.value = state.settings.apiKey;
    msg(keyst, 'Key saved.', 'good');
  }
  let keyTimer;
  const checkKey = async () => {
    const v = key.value.trim();
    if (!v) {
      await patch({ settings: { ...state.settings, apiKey: null } });
      return msg(keyst, '', '');
    }
    msg(keyst, 'Checking…', '');
    const r = await provider.validateKey(v);
    if (r.ok) {
      await patch({ settings: { ...state.settings, apiKey: v } });
      msg(keyst, 'Key works.', 'good');
      send('refresh', 'key');
    } else if (r.reason === 'rejected') {
      msg(keyst, 'That key was rejected.', 'bad');
    } else {
      // Offline: trust the paste, verify on the next refresh.
      await patch({ settings: { ...state.settings, apiKey: v } });
      msg(keyst, "Saved, but couldn't verify — you may be offline.", 'warn');
    }
  };
  key.addEventListener('input', () => { clearTimeout(keyTimer); keyTimer = setTimeout(checkKey, 600); });
  key.addEventListener('paste', () => { clearTimeout(keyTimer); keyTimer = setTimeout(checkKey, 60); });

  const TOGGLES = [['px', 'showPrices'], ['secCat', 'showCatalysts'],
    ['secIns', 'showInsiders'], ['secExt', 'showExtended']];
  const syncPx = () => {
    for (const [id, key] of TOGGLES) {
      const el2 = $(id);
      if (el2) el2.setAttribute('aria-checked', String(state.settings[key] !== false));
    }
    // extended hours is a detail of the prices section; disable it when that is off
    const ext = $('secExt');
    if (ext) {
      const off = state.settings.showPrices === false;
      ext.disabled = off;
      ext.closest('.rw')?.classList.toggle('off', off);
    }
    // Both of these features are deliberately invisible when there is nothing
    // to show. Without a status line the user can't tell that from broken.
    const insHint = $('insHint');
    if (insHint) {
      const n = Object.values(state.insiders.data || {}).reduce((a, v) => a + v.length, 0);
      insHint.textContent = state.settings.showInsiders === false ? ''
        : !state.insiders.fetchedAt ? 'Checking your tickers\u2026'
          : n ? `${n} notable ${n === 1 ? 'purchase' : 'purchases'} in the last 30 days.`
            : 'Nothing notable in the last 30 days. Routine vesting and scheduled '
              + 'sales are filtered out, so this stays empty most of the time.';
    }
    // When the keyless source is refusing us, say so plainly and name the fix.
    // "offline" was misleading: the network is fine, the provider is not.
    const srcst = $('srcst');
    if (srcst) {
      const blocked = state.quotes.stale && state.quotes.reason === 'blocked';
      srcst.textContent = blocked && !state.settings.apiKey
        ? 'The free data source is rate-limiting this browser. Adding a key above '
          + 'switches to Finnhub\u2019s official API, which is not subject to that.'
        : '';
      srcst.className = blocked && !state.settings.apiKey ? 'msg warn' : 'msg';
    }
    const extHint = $('extHint');
    if (extHint) {
      const phase = marketPhase();
      const live = phase === 'pre' || phase === 'after';
      extHint.textContent = state.settings.showExtended === false || state.settings.showPrices === false ? ''
        : live ? 'Showing now.'
          : 'Appears during pre-market (4:00\u20139:30am ET) and after-hours (4:00\u20138:00pm ET).';
    }
  };
  syncPx();
  for (const [id, key] of TOGGLES) {
    $(id)?.addEventListener('click', async (e) => {
      if (e.currentTarget.disabled) return;
      await patch({ settings: { ...state.settings, [key]: state.settings[key] === false } });
    });
  }

  const thm = $('thm');
  const syncThm = () => {
    for (const b of thm.children) b.className = b.dataset.t === (state.settings.theme || 'auto') ? 'on' : '';
  };
  syncThm();
  thm.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-t]');
    if (!b) return;
    applyTheme(b.dataset.t);
    await patch({ settings: { ...state.settings, theme: b.dataset.t } });
  });

  // Keep the panel in sync when storage changes underneath it.
  wrap._sync = () => { renderTickers(); syncPx(); syncThm(); };
}

function applyTheme(t) {
  if (t === 'dark' || t === 'light') document.documentElement.setAttribute('data-theme', t);
  else document.documentElement.removeAttribute('data-theme');
}

async function openSettings() {
  loadSettingsCss();
  if (!state) state = await getState(); // gear is live before hydrate() resolves
  if (!overlay) {
    overlay = buildOverlay();
    wireOverlay(overlay);
  }
  overlay._sync?.();
  lastFocus = document.activeElement;
  overlay.classList.add('on');
  document.addEventListener('keydown', onKeydownTrap, true);
  focusNow(overlay.querySelector('#addopen'));
}

function closeSettings() {
  if (!overlay) return;
  overlay.classList.remove('on');
  document.removeEventListener('keydown', onKeydownTrap, true);
  restoreFocus(el.gear);
}

/** Return focus where it came from, or to a sensible anchor if it came from
 *  nowhere — clicking a button on macOS doesn't focus it. */
function restoreFocus(fallback) {
  const target = lastFocus && lastFocus !== document.body && lastFocus.isConnected
    ? lastFocus : fallback;
  target?.focus?.();
}

function onKeydownTrap(e) {
  if (e.key === 'Escape') { e.preventDefault(); return closeSettings(); }
  if (e.key !== 'Tab') return;
  const f = overlay.querySelectorAll('button:not(:disabled), input:not(:disabled), a[href]');
  if (!f.length) return;
  const first = f[0];
  const last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

el.hold.addEventListener('click', (e) => {
  if (e.target.closest('#addcard')) { e.preventDefault(); return openSearch(); }
  const rm = e.target.closest('[data-rm]');
  if (rm) { e.preventDefault(); removeSymbol(rm.dataset.rm); }
  // the Google Finance anchor is left alone — default navigation is correct
});

// Clicking the footer forces a refresh. When something has gone wrong, the only
// recovery was opening another tab and hoping; this makes it explicit.
//
// The role/tabindex are set here rather than in the markup on purpose: the boot
// script and render.js must emit byte-identical HTML, so anything added to the
// rendered string has to be mirrored in both. Behaviour attached at runtime
// costs nothing there, and keeps the control reachable by keyboard.
el.upd.title = 'Refresh now';
el.upd.setAttribute('role', 'button');
el.upd.setAttribute('tabindex', '0');
el.upd.setAttribute('aria-label', 'Refresh now');
const forceRefresh = () => {
  el.upd.textContent = 'Updating\u2026';
  send('refresh', 'user');
};
el.upd.addEventListener('click', forceRefresh);
el.upd.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); forceRefresh(); }
});

el.gear.addEventListener('click', () => openSettings());
document.addEventListener('keydown', (e) => {
  if (overlay?.classList.contains('on')) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
  if (e.key === ',' || e.key === 's' || e.key === '/') { e.preventDefault(); openSettings(); }
});

hydrate();
