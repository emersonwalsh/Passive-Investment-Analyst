# Chrome Web Store submission sheet

Every field the Developer Dashboard asks for, with the value to paste. Written
for version **1.7.0**. Dashboard: <https://chrome.google.com/webstore/devconsole>

## 0. One-time account setup (only you can do this)

1. Sign in with the Google account that should own the listing.
2. Turn on **2-Step Verification** for that account — the store requires it
   before anything can be published.
3. **Register as a developer** and pay the one-time **$5** fee.
4. Accept the **Developer Agreement**.
5. In **Account**, add and verify a **contact email**. It can appear publicly on
   the listing, so a dedicated address keeps your personal inbox off it.
6. **Trader declaration** (EU Digital Services Act). Declare *non-trader* if
   the extension is free with no plan to earn from it. If you intend to monetize
   it, you are likely a *trader*, and the store then publishes the name, address
   and phone number you provide. This is a legal choice — yours to make.

## 1. Package

Upload `passive-investment-analyst-1.7.0.zip` (built from `catalyst/` with
`store/` and `README.md` excluded; see `store/README.md`).

## 2. Store listing

**Summary** — taken from `manifest.json`; it cannot be edited in the dashboard:

```
Upcoming earnings, insider buying and prices for the stocks you track — every time you open a tab.
```

**Description** — paste the *Detailed description* block from `LISTING.md`.

| Field | Value |
|---|---|
| Category | Productivity (there is no finance category; pick the closest option offered) |
| Language | English |
| Store icon | `catalyst/icons/128.png` |
| Screenshots | `store/screenshots/1-overview-light.png`, `2-overview-dark.png`, `3-search.png`, `4-settings.png` |
| Small promo tile | `store/promo-440x280.png` |
| Marquee promo tile | leave empty (only needed for featuring) |
| Official / homepage URL | `https://github.com/emersonwalsh/Passive-Investment-Analyst` |
| Support URL | `https://github.com/emersonwalsh/Passive-Investment-Analyst/issues` |
| Mature content | No |

## 3. Privacy practices

**Single purpose**

```
Replaces the new tab page with an earnings calendar, notable insider buying and a price overview for a stock watchlist the user chooses. Every feature serves that one purpose.
```

**Permission justification — storage**

```
Stores the user's ticker list, display settings and cached market data on the device, so the new tab paints instantly and keeps working offline. chrome.storage.sync carries only the ticker list and display preferences between the user's own signed-in Chrome browsers; the optional API key and all cached data are never synced.
```

**Permission justification — alarms**

```
Schedules background refreshes without a persistent background page: prices every 15 minutes during US market sessions, sparkline data every 30 minutes, and earnings dates once a day. Nothing is requested while markets are closed.
```

**Host permission justification**

```
api.nasdaq.com is the default, keyless data source: quotes, extended-hours prices, intraday price history, earnings dates and estimates, company search, and insider transactions (public SEC Form 4 data), requested only for tickers the user adds. financialmodelingprep.com and Finnhub's public logo CDN supply company logos, each fetched once and cached; Finnhub's CDN redirects between numbered subdomains, hence *.finnhub.io. finnhub.io is used for quotes and earnings only if the user adds their own optional API key. Requests carry a ticker symbol or a date, plus that key when supplied — no account or identifier.
```

**Remote code** — *No, I am not using remote code.*

**Data usage** — tick only:

- [x] **Authentication information** — the optional Finnhub API key a user may
  enter. It is stored on the device and sent only to finnhub.io, to authenticate
  the requests the user asked for. It is never synced or sent anywhere else.

Leave every other data type unticked: the extension has no server, collects
nothing for the developer, and sends market-data providers only ticker symbols
and dates.

**Certifications** — all three are true; tick them:

- [x] I do not sell or transfer user data to third parties, outside of the approved use cases
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL**

```
https://github.com/emersonwalsh/Passive-Investment-Analyst/blob/main/catalyst/store/PRIVACY.md
```

## 4. Distribution

| Field | Value |
|---|---|
| Payments | Free |
| Visibility | Public (or *Unlisted* to share by link first) |
| Regions | All regions |

## 5. Submit

Click **Submit for review**. New developers' first reviews often take several
business days. You can choose to publish automatically once approved, or to
publish manually.

## After it is live

- Reviewers sometimes ask about host permissions. `PERMISSIONS.md` maps each
  one to the exact source file.
- Every update: bump `version` in `manifest.json` and `BUILD` in
  `src/background.js`, run `node tests/run.mjs --all`, rebuild the zip, then
  upload it under **Package**.
