# Passive Investment Analyst

A new tab page that shows what's coming up for the stocks you track — earnings
dates first, prices second. No backend, no build step, no dependencies.

## Install (unpacked)

1. Open `chrome://extensions`, turn on **Developer mode**
2. **Load unpacked** → select this `catalyst/` folder
3. Open a new tab → paste a free [Finnhub key](https://finnhub.io/register)

After changing `manifest.json` or anything in `src/background.js`, hit **reload**
on the extension card — a page refresh alone won't pick it up.

## How it works

```
service worker  ──fetch──▶  chrome.storage.local  ──onChanged──▶  new tab page
   (alarms)                  (source of truth)                        │
                                                                      ▼
                                                localStorage 'cache:v1' mirror
                                                      │
                                    read synchronously by the next cold start
```

The new tab never awaits anything before painting. `src/boot.js` reads one
`localStorage` key and writes the list in the same tick the HTML parses. The
deferred module then hydrates: it re-renders with
`src/render.js` and touches the DOM **only if the markup actually differs**, so
the normal case is a no-op. Fresh data from the worker patches in afterwards.

MV3 service workers can't touch `localStorage`, so the mirror is written by the
page, never the worker.

### Why the boot script is a separate file, not inline

The spec called for an inline `<script>`. **Chrome forbids it.** MV3 extension
pages enforce `script-src 'self'` and the policy [cannot be relaxed][csp] —
`'unsafe-inline'` is rejected at install time. An inline boot script is silently
blocked and the page renders empty.

So `boot.js` is a classic (non-module, non-deferred) script placed at the end of
`<body>`. It still executes synchronously during parse, with the DOM above it
already available, so the paint behaviour is identical — it just costs one extra
extension-local resource read. Measured cost: still 1.6ms.

[csp]: https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy

### Why two renderers

A classic script can't `import` without becoming a module, and a module is
deferred — which would give up the synchronous paint. So the render logic exists
twice: compactly in `boot.js`, and canonically in `render.js`. They're kept
byte-identical, and the "only write if different" check makes any drift
self-correcting rather than visible.

### Refresh schedule

| Alarm | Period | Gate |
|---|---|---|
| `refresh-quotes` | 15 min | any live session — regular, pre-market or after-hours |
| `refresh-series` | 30 min | regular hours only; sparklines are decoration |
| `refresh-catalysts` | 24 h | 23 h floor; the day-scan inside it has its own 6 h floor |

What the quote alarm does depends on the session, and the distinction matters:

| ET | Phase | Alarm behaviour | Cost |
|---|---|---|---|
| 04:00–09:30 | pre-market | extended-hours price only | 1 req/symbol |
| 09:30–16:00 | regular | full quote refresh | 1 req/symbol |
| 16:00–20:00 | after-hours | extended-hours price only | 1 req/symbol |
| otherwise | closed | nothing | 0 |

Once the regular session closes the last trade price is frozen, so refetching it
is pure waste — only the extended-hours number moves. Those passes therefore
work from the cached close and spend the request on the figure that is actually
live, which is why adding two sessions a day did not double the request volume.

This was a real bug for as long as the feature existed. The refresh was gated on
`isRegularHours()`, but the extended-hours fetch lives *inside* that same
function — so pre-market and after-hours prices could only ever update when
something forced a refresh. The toggle was on, documented, and silently dead
outside 09:30–16:00. `cadence.mjs` now asserts the behaviour at every hour of
the day, including weekends.

One deliberate exception to the session gate: a **gap in what's tracked** lets a
fetch through — nothing fetched yet, or any symbol with no quote. Without it, a
ticker added at 9pm stays blank until 9:30am the next weekday. Once every
tracked symbol has data, the gate applies normally.

### On demand

The footer (`Updated 3 min ago`) is a real button — clickable, focusable, and
operable with Enter or Space. It forces a full refresh in **any** phase,
including weekends and overnight, clears any circuit-breaker backoff, and is the
only path allowed to override the 6-hour calendar-scan floor. When something has
gone wrong it is the one recovery control in the UI, so it is also the one that
must never be gated.

A card is always in exactly one of three states, never conflated:

| State | When | Shows |
|---|---|---|
| **Pending** | a fetch is in flight, or nothing fetched yet | shimmer + `Fetching…`, footer reads `Updating…` |
| **No data** | fetch finished, provider had nothing | `—` / `No data` |
| **Live** | quote present | price, change, sparkline |

In-flight is stored as `quotes.fetchingSince` — a **timestamp, not a boolean**.
A boolean set by a worker that Chrome then killed mid-request would strand every
card on "Fetching…" forever; a timestamp ages out after 30s and the card falls
back to `No data` on its own.

This matters most when adding a ticker: `fetchedAt` is already set from earlier
symbols, so without a pending state a brand-new ticker renders as `No data`
instantly — it looks broken while it's actually working.

### Failure handling

Finnhub's free tier is 60 requests/minute, and it's easy to burst past that when
a user adds tickers or force-refreshes — each refresh touches every symbol twice
(quotes + earnings). Three rules keep a burst from looking like an outage:

- **A 429 is retried with backoff**, honouring `Retry-After`, instead of dropping
  that symbol for the next 15 minutes.
- **A failure never discards data that did arrive.** An error is only surfaced
  when the batch returned nothing at all; otherwise the good quotes are kept.
- **Refreshes are sequenced, not parallel**, so quotes and earnings don't double
  the instantaneous burst against the same budget.

The footer names the actual cause — `offline`, `rate limited` or `key rejected` —
rather than calling everything "offline".

### Refresh gate invariants

These are the rules the `refresh-gates` suite pins down. Each existed because it
broke in production first:

- **A forced refresh is never absorbed by an in-flight passive one.** Passive
  passes may decide to skip; returning their promise to a forced caller silently
  discarded the force. Forced callers now wait for the passive pass, then run.
- **Catalysts are gap-aware, like quotes.** A symbol absent from
  `catalysts.data` has never been checked; one present with `[]` has been checked
  and has nothing scheduled. Without that distinction a ticker added after the
  daily fetch waited up to 23h for its earnings date — on the extension's
  primary feature.
- **Adding a symbol marks it pending immediately.** `addSymbol` sets
  `fetchingSince`, so the card reads as pending without waiting on the worker,
  and regardless of whether the worker then decides to skip.
- **`writeDiag` is serialized.** Catalysts and series refresh in parallel; a
  plain read-modify-write let them clobber each other's diagnostics.

### Third-party fragility

Search, sparklines and the earnings fallback all run on **undocumented** Nasdaq
endpoints. Each degrades independently rather than taking the page down:

| If this breaks | Result |
|---|---|
| autocomplete | typing a symbol offers "Add this ticker directly" — adding still works |
| chart | sparklines disappear; prices and earnings unaffected |
| earnings calendar | only used when Finnhub 403s; Coming up falls back to empty |

Adding a ticker must never depend on a single third-party URL, which is why the
direct-entry fallback exists.

### Diagnosing a stuck refresh

Swallowed errors made three separate failures indistinguishable from the UI, so
the worker now records what it did to `chrome.storage.local` under `diag`
(never the API key):

```bash
chrome.storage.local.get('diag').then(d => console.log(d.diag))
```

`build` is the worker's version stamp. **Page assets reload on every new tab, but
the service worker only updates when the extension is reloaded** from
`chrome://extensions` — so fresh UI running against a stale worker looks exactly
like a data bug. If `build` doesn't match `BUILD` in `src/background.js`, the
worker is stale; reload the extension.

All three refreshers report: `diag.quotes`, `diag.catalysts`, `diag.series`.

`skipped` says why no network call happened (`no-key`, `market-closed`,
`rate-floor`, `fresh-enough`, `gapfill-floor`). `errors` gives the per-symbol
reason (`HTTP 429`, `auth`, `timeout`, `network`, `no-data`). `unchecked` lists
symbols that had never been looked up.

Storage is at `schemaVersion: 4` — later versions added `series` (sparkline
points), `meta` (company name, exchange and cached logo per symbol), `results`
(reported quarters) and `insiders`. Each backfills on the next refresh, so a
migration only seeds empties and never discards what is already cached.

`backoff` appears in `diag` only while a circuit breaker is open, and gives the
seconds remaining per host. Its presence is the difference between "the network
is down" and "this host is refusing us".

Market hours are computed arithmetically from the US DST rules rather than via
`Intl.DateTimeFormat` — first-call ICU init is several ms, and this code runs on
the paint path. Verified against ICU on every hour of 2025–2027 (26,280/26,280).

## Data sources

`src/providers/` hides all network code. Callers never learn which source is in
use.

**Nasdaq** (default, keyless) — quotes, earnings dates, extended-hours prices,
reported results, company search and sparklines. Verified to return the same
price, net change and percent as Finnhub, which is what made a no-account
default possible. Everything below is unofficial and may break; each use
degrades independently.

**Finnhub** (optional upgrade) — if the user supplies their own key, quotes and
earnings switch to Finnhub's documented API. Its calendar takes a date range, so
it covers a full 90 days in one request, where the keyless path needs a
per-symbol lookup plus, when that comes back empty, a day-by-day scan out to
Nasdaq's own data frontier. A rejected or rate-limited key falls back to the
keyless source rather than showing an empty grid.

A key is also the answer when the free source starts refusing this particular
browser: Finnhub's official API is not subject to the bot protection that
sometimes soft-blocks Nasdaq's undocumented endpoints. Settings says so
directly when the circuit breaker is open.

**Nasdaq** (keyless) — three jobs, none of which need an API key:

- *Earnings fallback.* If a key gets `403` on Finnhub's calendar, the provider
  transparently switches to Nasdaq's public calendar JSON.
- *Sparkline series.* `/api/quote/{SYM}/chart` returns a full intraday path,
  ~17KB gzipped, downsampled to 40 points before storage. Nasdaq's own
  `percentageChange` disagrees with Finnhub's at times, so **nothing from this
  endpoint is used for the displayed price or change** — shape only.
- *Symbol search.* `/api/autocomplete/slookup` powers company-or-ticker
  autocomplete. Because it needs no key, search works before the user has
  entered one.

All unofficial and may break; every failure degrades to "no data" rather than an
error. Ordinary shares are ranked above ETFs in search results — typing "tesl"
should surface Tesla, not a leveraged TSLA product whose ticker matches exactly.

No API key is embedded anywhere in the source. Users supply their own, it's
stored in `chrome.storage.local` on their device only, and it is deliberately
never written to the `localStorage` mirror.

## Verified

| Criterion | Result |
|---|---|
| Paint under 50ms cold | **0.2–1.7ms** (boot script, measured in-page) |
| Zero layout shift | **CLS 0**, zero `layout-shift` entries |
| Skeleton ↔ real parity | rows 40px / cells 80px in both states |
| Offline shows cached data | yes, footer reads `Updated 2 hr ago · offline` |
| No spinner with cache present | yes |
| Live quote update | patches text in the existing node, 0 shift, no grid rebuild |
| Removing a ticker prunes caches | quote + catalyst entries both dropped |
| Invalid ticker | inline error, not saved (verified against live Finnhub 401) |
| Renderer parity | all cases byte-identical, junk cache included |
| Card heights uniform | 138px across live, skeleton and add cards |
| Hover actions | reveal with zero height change |
| Runs under real MV3 CSP | yes — verified with `script-src 'self'` enforced, 0 console errors |
| Third-party runtime deps | none |
| Search returns live results | yes — autocomplete, in-browser, under enforced CSP |
| Search degrades honestly | dead endpoint → "add this ticker directly", never a silent hang |
| A stuck fetch resolves | "Fetching…" ages out to "No data" in 30s, verified in-browser |
| Add saves the company name | "Coincheck Group N.V. Warrants", not the ticker |
| Remove prunes `meta` too | yes — no orphaned entry left behind |
| Sort persists | key and direction both survive a reload |
| Section toggles restore | turning insider buying off and back on restores the section |
| Earnings dates resolve live | yes — INTC/TMUS dated with EPS estimates, no scan gaps |
| Cost of adding a ticker | 7 requests, flat, regardless of watchlist size |
| Extended hours refresh unattended | yes — verified at 05:00, 17:30 and 19:45 ET |
| On-demand refresh | works in all five phases, incl. weekend and overnight |
| Refresh control is keyboard-operable | yes — `button`, focusable, Enter/Space |
| Building a watchlist | 8 rapid adds → 101 requests, 1 calendar scan |
| Responsive, no horizontal overflow | verified at 320 / 375 / 430 / 768 / 1000 / 1600px |
| Modals on mobile | settings and search both full-width sheets, no overflow |
| Works on older Chrome | full real-browser suite passes on Chrome 115, 127 and 136 |
| First tab after install | no "add your first stock" flash, zero layout shift |
| Every new tab | zero layout shift in real Chrome (header no longer collapses before boot) |
| 25-ticker refresh from an alarm | completes with no debugger attached; worker not killed mid-pass |
| Prices | match CNBC's consolidated close to the cent, 22 tickers incl. NYSE, ADRs, ETFs, BRK.B |
| Quotes in every session | 1,364 live samples over 17 days replayed through the real code: all match CNBC, exact to the cent outside the live session |
| Card links | every venue resolves on Google Finance, incl. Cboe BZX ETFs |
| Insider rows link to the source | every live insider buy's link finds that filer's Form 4 on sec.gov; mouse and keyboard verified in real Chrome |
| Earnings dates | Zacks' listed dates agree with stockanalysis.com 55/58; projections only 17/28, so those are marked `~`. Nothing claims company confirmation (Wells Fargo's Q3 2026 date was a day off its own IR page) |
| Insider buys | shares and dollar value match the SEC Form 4, transaction code P |
| Automated coverage | `tests/` at the project root — see `tests/README.md` |

Measure boot time yourself:

```bash
# in the new tab's console, then reload
localStorage.setItem('catalyst:debug','1')
```

`window.__catalystBoot` always holds the number; the debug flag only adds the
console line, so shipped tabs stay quiet.

## Sections

Two sections, each independently hideable in settings — some people want only
the calendar, some only the prices.

**Earnings calendar** — grouped This week / Next week / Later over a **90-day**
horizon, so every tracked symbol shows its next report rather than going blank
between earnings seasons. Widening from 35 to 90 days costs nothing: Finnhub
takes a date range, so it is the same one request per symbol per day. The Nasdaq
fallback is per-date, so it carries a hard 64-request ceiling plus an early exit
once every symbol has been found.

Anything reporting **today or tomorrow** gets an accent rail, a warm wash, a
pulsing pip and accent type — the row you must not miss is the row that looks
different. Everything within 5 days keeps the quieter amber treatment.

**Today's movement** — the price cards.

## Company logos

Fetched **once** per symbol from two independent keyless CDNs, downscaled to
40px in the service worker via `OffscreenCanvas`, and stored as a WebP data URI
in `meta`.

Financial Modeling Prep is tried first, then Finnhub's image CDN. Two sources is
not belt-and-braces — it is required for correctness. Finnhub still files Meta
under its **former ticker** (`META.png` 404s, `FB.png` works), and has nothing
for recent listings like FIG. FMP covers both and 404s honestly on unknown
symbols. One source going away degrades coverage instead of removing logos.

The downscale is not cosmetic. Source logos are 1000x1000 and average ~32KB, so
25 of them raw would be **~1.1MB of base64 parsed synchronously on every new
tab** — enough to destroy the paint budget on its own. Re-encoded they are
~1.3KB each, about 32KB for a full watchlist. Measured: NVDA 61,706 bytes ->
1,403 chars.

Anything still without a logo falls back to a **monogram**: the ticker's first two letters on a
hue derived deterministically from the symbol. Both occupy the same 18px box, so
the swap can never shift layout. A symbol is marked "checked, none" with an
explicit `null`; a *transient* failure omits the key so it retries later.

The renderer only accepts a `data:image/` URI, so a poisoned cache cannot cause
a remote image request.

## Accessibility

All text meets **WCAG AA (4.5:1)**, verified by computing the actual composited
contrast of every token against its background — the muted palette originally
failed badly (`--dim` at 2.20:1) on real content: company names, the net-change
figure, a flat 0.00%. Tokens were raised until the worst text ratio is 4.50, and
a separate `--faint` token carries the genuinely decorative chrome so the design
stays quiet without making content illegible.

Hover actions are real focusable controls, overlays trap focus and close on
Esc, focus is restored on close, the live pip is `aria-hidden`, and logo images
carry empty alt text since the ticker beside them is the label.

## Insider buying

Notable open-market purchases by executives and directors, for tracked symbols
only. Rendered above the calendar, and **absent entirely when there is nothing
notable** — a quiet watchlist costs no vertical space.

The hard part is signal, not data. Across 30 tickers the observed mix was 295
RSU vestings, 270 dispositions, 155 option exercises and 224 sells against only
38 genuine `Buy` rows. `Automatic Buy` is a scheduled plan and carries no price,
so it is excluded too. Showing the raw feed would surface *"Automatic Sell —
500,000 shares"*, which reads alarming and means nothing.

"Notable" has to hold for a $3T company and a $200M one alike, so it is
deliberately two-sided rather than one dollar cutoff:

| Test | Threshold | Why |
|---|---|---|
| Absolute | value ≥ $500k | a large personal commitment at any company size |
| Conviction | stake increase ≥ 25%, value ≥ $50k | scales with company size; the floor stops token buys qualifying on percentage |

A brand-new position counts as a large increase by definition. Validated against
live data: Intel's CEO buying $10M and a three-insider cluster at Pfizer pass;
a CEO's routine $251k at +0% of an existing stake does not.

### Making an invisible feature legible

Insider buying and extended hours are both deliberately absent when there is
nothing to show — which is right for a glanceable page, but leaves the user
unable to tell "working and quiet" from "broken". Settings therefore carries a
live status line for each: *"Nothing notable in the last 30 days"*, or
*"Appears during pre-market and after-hours"*, or a count when there is one.

The page stays silent; the explanation lives where someone goes looking.


### Every row links to its SEC filing

Clicking an insider row (or Enter on it) opens the SEC's own full-text search
for that person's Form 4 at that company, filed within ten days of the trade —
the filing is the source of truth for every figure on the row.

The link is built from what every Form 4 contains, the filer's name and the
company's ticker, because Nasdaq supplies no filing ID and its insider IDs are
**not** SEC CIKs (0 of 79 matched — linking by them would have opened other
people's filings). Against known filings the search returned exactly the right
Form 4 in 5 of 6 cases, and that filing plus one other by the same person in
the sixth. `tests/accuracy.test.mjs` runs every live insider row's link on
sec.gov and requires that filer's Form 4 at that company to come back.

The link is laid over the row (`.rlink`), so the whole row is the target and
nothing about its layout changes; it opens a new tab and is keyboard-reachable.

## Request discipline

`src/net.js` is the single gate for every outbound request. Three things happen
there, and each one exists because of a specific failure.

**Per-host lanes.** Concurrency and spacing are per-host, and deliberately low
for the keyless endpoints: `api.nasdaq.com` gets **2 concurrent, 150ms apart**;
everything else gets 6 at 40ms.

This is the fix for `net::ERR_HTTP2_PROTOCOL_ERROR`. Node and curl open a fresh
connection per request over HTTP/1.1, so six "concurrent" requests look like six
ordinary clients — which is why every local test passed while the packed
extension failed. Chrome speaks HTTP/2 and multiplexes all six onto **one**
connection, so the host sees six simultaneous streams from a single socket:
exactly the signature bot protection looks for. It answers by resetting the
stream, and the extension sees a blanket network failure.

**Interactive priority.** A request marked `priority` jumps the queue. At two
lanes a background refresh is several seconds of queued work, and search sat
behind it — which is what made the search box look broken. Note that `priority`
is stripped before `fetch()` sees it: the platform has an option of the same
name whose only legal values are `high`/`low`/`auto`, and passing ours through
would throw and break the very call it was meant to speed up.

**A per-host circuit breaker.** After 4 consecutive network failures to a host,
stop calling it and fail fast, backing off 1m → 5m → 15m → 30m. One success
closes it completely. Retrying into a soft block deepens it and floods the
console. A tripped breaker is reported honestly — the footer reads *data source
unavailable*, not "offline" — and an explicit refresh clears it, because the
user asking is worth one try.

**Timeouts are never retried.** Every request is time-boxed at 8s. Without this
one hung connection holds a queue slot forever; enough of them deadlock the gate
permanently, which presents as a totally dead extension — no prices, no search,
no insider data, and no error to show for it. Verified: with all slots hung, a
new request still completes.

### What a refresh actually costs

| Cycle | Cadence | Requests |
|---|---|---|
| Quotes (regular session) | every 15 min | ~1 per symbol |
| Extended-hours (pre/after) | every 15 min | ~1 per symbol |
| **Adding a ticker** | per add | **7, flat** |
| Full refresh incl. earnings scan | at most every 6 h | up to ~71 |

The per-add figure is the one that matters, and it was the bug that got a real
user's browser soft-blocked. Adding a ticker forced a *full* refresh: every
symbol's quote, extended-hours quote, sparkline, logo, insider history and
earnings lookup, plus a ~45-request calendar scan — and it cleared the circuit
breaker on the way in, so the protection could never engage. Building a
watchlist therefore cost several hundred requests at one bot-protected host in
a couple of minutes, and the host started resetting streams.

Now an add names the ticker it added, every refresher fetches only that symbol,
and the expensive calendar scan has its own 6-hour floor that `force` does not
lift. Eight rapid adds cost 101 requests in total, including one legitimate
initial scan. Only an explicit user refresh (clicking the footer) or a key
change may override the floor and clear the breaker.

## The earnings calendar is only allowed to claim what it knows

An empty calendar looked identical to the user whether the data was genuinely
absent or the extension had thrown it away. Three separate bugs each produced
that same blank section, so the rules are now explicit and covered by tests.

**"The vendor has no date" is not "there is no date."** Nasdaq's per-symbol
endpoint answers `200` with prose saying Zacks hasn't published the next date
yet. That was being read as an authoritative "nothing scheduled" *and* counted
as a resolved symbol, which suppressed the calendar scan entirely — so a whole
watchlist reported nothing upcoming while the calendar plainly held the dates.

**Nasdaq says "no earnings that day" two different ways.** Both `data: null` and
`data: { asOf, rows: null }` are real answers. Only the first was recognised;
the second was treated as a malformed body, and because one unreadable day
withholds every symbol, a single quiet Friday blanked the entire calendar.

**One symbol's failure is not every symbol's failure.** An ETF has no earnings
endpoint at all, so its per-symbol lookup errors. That used to set a global
"incomplete" flag and omit every other symbol's result too.

The scan stops once it has seen 10 consecutive empty weekdays — that is the
frontier of what the source actually holds, not a gap in the reading, so
stopping there still counts as a complete read. Ten, rather than a handful,
because a week of thin days between reporting seasons is ordinary and stopping
at the first lull would abandon the scan short of real dates.

## Two rules that keep the UI stable

Every stability bug that reached production came from breaking one of these.

**1. A failed read is never written back as fact.** `getCatalysts` returning
`[]` means "checked the whole window, nothing scheduled", and the caller
overwrites its cache on that basis — so a scan with any failed day omits those
symbols instead. The same applies to logos, insider buys and results: a symbol
that could not be read is *omitted*, and the caller keeps what it had. Breaking
this made earnings rows appear and vanish, and made the insider section
disappear after a network blip.

**2. Shared objects are merged through one serialized writer, never
snapshot-and-replaced.** Three refreshers enrich `meta` concurrently — quotes
learn name/exchange/class, series backfills labels, logos add the image. Each
used to copy a snapshot and write the whole object back, so whichever finished
last silently discarded the others' fields. That is why company logos appeared
and then reverted to monograms. `mergeMeta()` re-reads inside a promise chain,
which makes the merges commutative. `writeDiag()` uses the same pattern.

A corollary for the UI: **a slow refresh must never look like a broken one.**
The footer appends `· updating` rather than replacing the timestamp, and the
pending card state schedules its own repaint for when its window lapses.

## Trusting an empty result

`getCatalysts` returning `[]` means "checked the whole window, nothing
scheduled", and the caller overwrites its cache on that basis. So a scan with
any failed day must NOT make that claim — those symbols are omitted instead,
leaving cached dates intact. Getting this wrong made earnings rows appear and
vanish between refreshes with no user action.

The same rule governs logos, insider buys and results: **absence is only
recorded as fact after a clean read.**

## Sorting

The holdings grid sorts by **% change, high to low** by default, with Name as
the alternative and a direction toggle. Clicking the already-active field flips
direction. Symbols with no quote always sink to the bottom regardless of
direction — a pending card should never win "top mover".

Sorting by % change means the grid genuinely reorders when fresh quotes land.
That's intended, and it's why the order-sensitive `sameCells` check falls back
to a full re-render rather than patching text in place.

## Holdings cards

### Updates never rebuild the grid

Background updates reach the cards constantly — a sparkline every 30 minutes, a
logo or company name after an add, prices every 15. The grid used to be rebuilt
with `innerHTML` for anything but a pure price change, which destroyed every
card node. Measured in real Chrome: a click on a card's remove button that
straddled one of those updates **never fired**, and keyboard focus on a card
fell back to `<body>`. The entrance animation also replayed each time.

`reconcileHold()` in `src/newtab.js` now matches cards by ticker and morphs them
in place, so a button being pressed or focused is the same element before and
after, and only cards whose position changed are moved. Two details matter:

- The quote patcher's `data-k` marker (which price a card shows) survives a
  morph only if that element's text didn't change. Keeping a stale marker could
  make a later patch skip a real price change.
- `tests/chrome.test.mjs` proves faithfulness: a tab put through many in-place
  updates must be structurally identical to a freshly rendered tab.

Google Finance-style: symbol, company name, price, net change and percent, and a
sparkline of the day's path with a dotted line at the previous close. Green above
the close, red below, grey when flat.

Hovering a card lifts it, deepens its shadow and brightens the sparkline fill,
and reveals two actions — open in Google Finance, and remove. The action buttons
occupy reserved space at all times, so revealing them can't shift the layout,
and they're real focusable controls so keyboard users reach them too.

The whole card is a link. The Google Finance anchor is stretched over the card
with `::after { inset: 0 }` rather than wiring a click handler, which keeps real
anchor semantics — cmd-click, middle-click and "open in new tab" all work — with
the remove button layered above it.

A dashed **+ Add stock** card sits at the end of the grid and opens a search
box: type a company name or ticker, arrow keys to move, Enter to add. Typing a
new query clears the previous results immediately, so Enter during an in-flight
search can't add the wrong symbol.

Google Finance quote URLs **require** an exchange — a bare
`/finance/quote/NVDA` lands on the Google Finance home page rather than a quote.
Exchange comes from search or the chart endpoint and is stored per symbol; when
it's genuinely unknown the link falls back to a Google search.

## Keyboard

`s` or `,` opens settings, `Esc` closes, `Tab` cycles within the panel.
Chrome focuses the omnibox on a new tab, so click the page first.

## A quote only means something with its session

Nasdaq's quote block does not mean the same thing all day. During pre-market and
after-hours it carries the **extended** trade, and its change is measured against
that day's *regular close* — not the previous one. Read as an ordinary quote, the
after-hours price lands in the day's slot and the day's move is replaced by the
after-hours move.

That is what shipped in 1.6.0 and what a user saw: SHOP closed at 129.86, down
3.01%, and the card read **130.00 +0.11%**. Replayed against 17 days of live
captures, that parser showed the right after-hours price in 16 of 324 samples
and the right pre-market price in none.

`readQuote()` in `src/providers/nasdaq.js` reads a payload in the frame of its
session:

| Session | Card price | Card change | Extended line |
|---|---|---|---|
| Regular | live price | vs previous close | — |
| Pre-market / after-hours | `last − net` (the regular close) | vs the stored previous close | `last`, already measured against the close |
| Closed | official close | vs previous close | — |

Every rule below came from live data, not inference:

- **Nasdaq's own `marketStatus` picks the frame** (`Open`, `Pre-Market`,
  `After-Hours`, `Closed`); our clock only breaks ties. It stays `After-Hours`
  well past 8pm, and a calendar does not know about half-days.
- **The official close has to be fetched after the bell.** 1.6.1 skipped quotes
  outside the regular session on the theory that the close is frozen — but its
  last fetch was up to 15 minutes *before* the bell, so cards showed a
  mid-afternoon price as the close all evening. Now a card is refetched until it
  has been read after the close settled (`lastSettledCloseAt()`, 16:20 ET),
  and during extended sessions the same request supplies the extended line, so
  the dedicated extended-hours call is only a fallback. No extra requests.
- **An empty change field means the price is the close.** Nasdaq leaves it blank
  until its extended quote starts; `last` matched the official close in 12 of 13
  such reads (the 13th was 2 cents into the closing auction at 16:00:01).
  Anything *unreadable* is still refused and the card kept, without calling the
  source offline.
- **The 4am Monday rollover is detected.** For a few minutes Nasdaq measures the
  pre-market trade against the session *before* the last one, so `last − net`
  recovers the previous close. When the card already holds a later close, that
  payload is refused. This guard runs in pre-market only — after the bell it
  would refuse a genuine unchanged close.
- **Extended trading cannot change the previous close**, so the stored one is the
  reference for the day's move. A first install during an extended session has
  none, and the card shows the close with no percentage rather than a wrong one.

`tests/replay.test.mjs` replays captured sessions through the real code path
with the fetch policy emulated at each sample's time. On the September capture
— 1,364 samples across every session, including the minutes after the bell and
a Monday rollover — every card matches CNBC: exact to the cent outside the live
session, within a tick during it.

## Data honesty

What the page claims is held to what the source actually knows, because a wrong
number on a glanceable dashboard does more harm than a missing one.

- **Projected earnings dates are marked, and no date is called confirmed.**
  Nasdaq's per-symbol text says either "is *expected\** to report" (Zacks'
  listed date, usually the company's announcement) or "is *estimated* to report"
  (Zacks' projection from past reporting dates). Measured against an independent
  source across 86 companies, listed dates agreed 55 of 58 times and projections
  only 17 of 28 — often a week out — so projections show as `in ~45 days` with a
  legend. 1.6.0 also implied unmarked dates were *confirmed by the company*; they
  are not: Zacks listed Wells Fargo's Q3 2026 report for Oct 14 while Wells
  Fargo's own investor-relations page says Oct 13. So the legend describes only
  the `~`, and Settings says dates come from Zacks and can differ from the
  company's announcement. `tests/accuracy.test.mjs` tracks the agreement rate
  and fails below 90%.
- **Surprises are proportionate.** A 4-cent miss on a $0.05 estimate reads
  "missed by $0.04", not "missed 80%". Rows say "EPS", use a real minus sign,
  and note that Zacks' basis can differ from a company's adjusted figure.
- **Insider rows show who, role and dollar value — no stake percentage.**
  Nasdaq's "shares held" belongs to whichever account the purchase went
  through. Oracle director Stephen Rusckowski bought 25,000 shares through his
  living trust; the row read "+6410.3%" because the trust went from 390 to
  25,390 shares, while he held 60 directly (SEC Form 4, 29 Sep 2026). 1.6.0
  labelled the figure "direct holdings", which was false here. The extension
  cannot read the full filing (SEC requires a User-Agent extensions are not
  allowed to set), so the percentage is no longer shown; it only informs
  whether a buy counts as notable.
- **Card names are companies**, not securities: "Common Stock", "Class A
  Common Stock" and ADR suffixes are dropped, but only as a whole tail.

## Layout

Two columns once there is room, stacking below 1000px:

| Width | Layout | Cards per row |
|---|---|---|
| ≥ 1000px | today's movement left, calendar + insider buys right | 3–4 |
| 430–999px | single column, movement first | 3–5 |
| < 430px | single column, card grid pinned to 2 | 2 |

`main` is a CSS grid; `.app` caps at 1180px. Three details carry the whole
thing, and each was a real defect:

**Movement comes first in the DOM, not just visually.** It occupies the
left/primary column, so putting it first keeps reading order and visual order
identical. Flipping the columns with CSS `order` instead would have left the
tab order running right-to-left.

**Every element in the layout chain opts out of `min-width:auto`.** Grid and
flex children refuse to shrink below their content's min-content width by
default, which forced a horizontal scrollbar at 320px — the card grid reported
334px inside a 284px space. `main > section{min-width:0}` plus a pinned
two-track grid under 430px fixes it. Verified: no horizontal overflow at 320,
375, 430, 768, 1000, or 1600px.

**There is a viewport meta.** Without it a narrow window is laid out against a
~980px virtual viewport and then scaled down, so none of the breakpoints fire
and the page renders as a shrunken desktop layout. It was missing, and mobile
looked exactly like desktop-at-40%.

Either column can be switched off in settings, in which case the survivor spans
the full width via `:has()` rather than sitting in half an empty page. The rule
between the blocks only appears when they are stacked; side by side the grid gap
separates them. `audit.mjs` asserts all of this structurally.

Worst case (8 catalyst rows + 8 holdings) now splits across two columns rather
than stacking to ~843px, so far more fits above the fold on a short viewport.

## Notes on cost and distribution

Running cost is genuinely zero — there is no server, and each user's data comes
from their own API key under their own rate limit. That property holds no matter
how many installs you get, which is the main thing that makes this scalable.

The honest tradeoff is that bring-your-own-key is the biggest drag on install
conversion. Most people who install a new tab extension will not go create a
Finnhub account. If you want reach, that's the first thing to attack — the empty
state is already a single field with a direct signup link, but it's still a wall.

On revenue: Chrome removed in-app payments and paid listings from the Web Store,
so there's no native way to charge. The realistic options are a license check
against a hosted service (ExtensionPay, Lemon Squeezy) for a paid tier, or
affiliate/referral placement. Both conflict with the "no backend, ever"
constraint to some degree, which is why neither is built here — per spec, v1 has
no payment or license-gating abstractions. Worth deciding deliberately later
rather than designing around now.

If you do publish: the Web Store will require a privacy disclosure, since the
extension stores a user-supplied API key. The accurate answer is that all data
stays on the user's device and nothing is transmitted anywhere except directly to
the data provider.

## Files

```
manifest.json
newtab.html          inline critical CSS, no inline script (MV3 forbids it)
src/
  boot.js            synchronous first paint from the localStorage mirror
  newtab.js          hydration, targeted DOM patching, settings panel
  render.js          pure functions: state -> HTML string
  store.js           chrome.storage.local wrapper, schema, migrate()
  cache-bridge.js    localStorage mirror
  market-hours.js    US market phase, no Intl
  background.js      service worker: alarms, fetch orchestration
  providers/
    index.js         the active provider (one-line swap)
    finnhub.js       quotes + earnings, validation, Nasdaq failover
    nasdaq.js        keyless: earnings fallback, sparkline series, symbol search
styles/settings.css  deferred, loaded non-blocking
icons/
```
