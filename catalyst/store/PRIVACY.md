# Passive Investment Analyst — Privacy Policy

_Last updated: 14 September 2026_

Passive Investment Analyst does not collect, sell, or share any personal information. It has no
server, so nothing you enter is ever sent to the developer.

## What Passive Investment Analyst stores

Everything Passive Investment Analyst stores lives on your own device, in your browser's extension
storage. Nothing is uploaded to us, because there is no "us" — Passive Investment Analyst has no
server, no database, and no backend of any kind.

| Stored on your device | Why |
|---|---|
| Your ticker list | To know which stocks to show |
| Your Finnhub API key (optional) | To make requests to Finnhub on your behalf. Never synced between devices. |
| Cached prices and earnings dates | So the new tab renders instantly and works offline |
| Company names, exchanges and logos | To label cards and build "open in Google Finance" links |
| Your display settings (theme, sections, sort) | To remember your preferences |
| A random device identifier | Created on install so this browser can recognise its own sync writes. It is not linked to you, your account, or your device, and is never sent to any data provider. |
| Recently reported earnings results | To show how a company did against estimates |
| Notable insider purchases | To surface open-market buys by company executives |

## Where your data goes

Passive Investment Analyst makes network requests to exactly three providers, and only to fetch
the market data and logos it displays:

**finnhub.io** — *optional*. Passive Investment Analyst works without any account. If you choose
to add a Finnhub API key, quotes and earnings dates are sourced from Finnhub
instead, and those requests include the key **you** supplied, because that is
how Finnhub authenticates you. Your key is
never sent anywhere else, and it is never written to the page's local cache.
Company logos are also fetched from Finnhub's public image CDN; those requests
carry only a ticker symbol and no key, and each logo is downloaded once and then
stored on your device.
Finnhub's own privacy policy governs how they handle those requests:
<https://finnhub.io/privacy-policy>

**financialmodelingprep.com** — company logos. These requests contain only a
ticker symbol. No key, no account, no identifier. Each logo is downloaded once
and then stored on your device.

**api.nasdaq.com** — the default source for everything: quotes, earnings dates,
extended-hours prices, reported results, company name search, intraday price history for the
sparklines, and a fallback earnings calendar. These requests contain only a
ticker symbol or a date. No key, no account, no identifier of any kind is sent.

No other network requests are made. Passive Investment Analyst contains no analytics, no telemetry,
no advertising, no tracking pixels, no cookies, and no third-party scripts. It
loads no remote code — every file that runs is included in the extension package
and reviewable in the source.

## What Passive Investment Analyst never does

- It never reads your browsing history, bookmarks, tabs, or the content of any
  web page. It has no permission to do so.
- It never sees your Finnhub account, portfolio, positions, or balances.
  Passive Investment Analyst only reads public market data.
- It never sends your ticker list, settings, or API key to the developer.
- It never sends your API key anywhere except Finnhub, and only if you add one.
- Ticker symbols do reach the data providers listed above — that is how prices
  and dates are fetched — but only one symbol per request, with no account,
  identifier, or other information attached.

## Cross-device sync

If you are signed into Chrome, your ticker list, display preferences, the
company names and exchanges shown on your cards, and the random device
identifier described above sync between your own browsers using Chrome's
built-in extension sync. That data goes to your Google account, not to us —
Passive Investment Analyst has no server to send it to.

Your API key is deliberately **excluded** from sync and never leaves the device
you entered it on. Cached prices, charts and logos are also excluded.

## Deleting your data

Removing a ticker deletes its cached quote, earnings, and company data
immediately. Uninstalling the extension removes everything Passive Investment Analyst has stored.
There is nothing held elsewhere to request the deletion of.

## Children

Passive Investment Analyst is not directed at children and collects no information from anyone.

## Changes

Any change to this policy will be published with the corresponding extension
update and reflected in the date above.

## Contact

Questions about this policy: emersonwalsh@gmail.com
