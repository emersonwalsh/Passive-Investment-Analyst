# Permission justifications

Chrome Web Store review asks for a written justification per permission. These
are written to be verifiable against the source.

## `storage`
Two uses:

1. `chrome.storage.local` holds the ticker list, display settings, and the
   cached quotes, earnings dates and logos that let the new tab paint instantly
   and keep working offline. Written by `src/store.js`.
2. `chrome.storage.sync` carries **only** the ticker list and display
   preferences between the user's own signed-in Chrome browsers — roughly 2.6KB
   for a full list. The API key and all caches are explicitly excluded; see
   `src/sync.js`, which enumerates exactly what travels.

No storage permission beyond `storage` is required for either.

## `alarms`
Schedules background refreshes without a persistent background page: prices
every 15 minutes during the US regular session (and, if the user leaves
extended hours on, during pre-market and after-hours, when only the
extended-hours price is refreshed), sparkline data every 30 minutes, and
earnings dates once a day. Nothing is requested while the market is closed. Using alarms rather than timers is what allows the
service worker to stay dormant between refreshes. Registered in
`src/background.js`.

## `chrome_url_overrides.newtab`
The extension's single purpose is replacing the new tab page with the earnings
calendar. This is the feature itself, not a supporting permission.

## Host permission — `https://*.finnhub.io/*`
**Optional at runtime.** Passive Investment Analyst works with no account at all; Finnhub is only
contacted if the user chooses to supply their own API key. Two uses, both in
`src/providers/finnhub.js`:

1. **Quotes and earnings dates** from `finnhub.io` (`/quote`,
   `/calendar/earnings`) using an API key the **user** supplies in settings. No
   key is embedded in the extension. Requests carry only a ticker symbol, a date
   range, and the user's own key.
2. **Company logos** (fallback source) from Finnhub's public image CDN
   (`static2.finnhub.io/.../stock_logo/{TICKER}.png`), which requires no key and
   receives only a ticker symbol. The wildcard is necessary because that host
   redirects to a numbered sibling (`static2` -> `static9`) that varies.

Each logo is fetched **once**, downscaled to 40px in the service worker, and
stored locally; it is never re-requested and never leaves the device.

## Host permission — `https://api.nasdaq.com/*`
The default, keyless data source. Every use is read-only and requested only for
tickers the user has added; requests contain a ticker symbol or a date and no
key, account, or identifier.

1. **Quotes** (`/api/quote/{symbol}/info`) — price and daily change.
2. **Extended-hours prices** (`/api/quote/{symbol}/extended-trading`) — only
   during pre-market and after-hours sessions, and only if the user leaves that
   section on.
3. **Intraday price history** (`/api/quote/{symbol}/chart`) — the sparkline on
   each card.
4. **Earnings dates** (`/api/analyst/{symbol}/earnings-date`) — the next report
   date for each ticker, and whether the company has confirmed it.
5. **Earnings calendar** (`/api/calendar/earnings`) — looked up day by day only
   for tickers the per-symbol lookup could not date, at most once every six
   hours.
6. **Consensus and reported EPS** (`/api/quote/{symbol}/eps`) — the estimate on
   upcoming reports, and beat/miss for a few days after a company reports.
7. **Insider transactions** (`/api/company/{symbol}/insider-trades`) — to surface
   notable open-market purchases by executives and directors. This is public
   SEC Form 4 data.
8. **Company search** (`/api/autocomplete/slookup`) — so users can add a stock by
   company name instead of memorising a ticker.

Implemented in `src/providers/nasdaq.js`, paced through a single request gate in
`src/net.js` that limits this host to two concurrent requests.

## Host permission — `https://financialmodelingprep.com/*`
Primary source for company logos (`/image-stock/{TICKER}.png`). Requires no API
key and receives only a ticker symbol. It is listed first because it covers
tickers Finnhub's CDN misses (Finnhub still files Meta under its former ticker,
`FB`) and returns a correct 404 for unknown symbols. Two independent logo
sources means one going away degrades coverage rather than removing logos.
Implemented in `src/providers/logos.js`.

Each logo is fetched **once**, downscaled to 40px in the service worker, stored
locally, and never re-requested.

---

## Notes for the reviewer

- **No remote code.** Every script that executes ships inside the package. There
  is no `eval`, no injected `<script>` with a remote `src`, and no CDN. The
  extension runs under the default MV3 CSP (`script-src 'self'`) with no
  relaxation requested.
- **No content scripts.** Passive Investment Analyst never reads or modifies any web page and
  requests no permission that would let it.
- **No analytics or tracking of any kind.**
- **Data handling disclosure:** the extension stores a user-provided API key
  locally and transmits it only to `finnhub.io`, the service that issued it.
  This is disclosed in the privacy policy.
