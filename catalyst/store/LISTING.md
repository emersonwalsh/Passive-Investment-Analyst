# Chrome Web Store listing — Passive Investment Analyst

Copy-paste ready. Character limits are the Web Store's, counts are current.

---

## Name (45 max)
```
Passive Investment Analyst
```
`26 chars`

## Short description (132 max)
```
See which of your stocks report earnings next, every time you open a tab. No account, no signup — just open a tab.
```
`122 chars`

## Category
`Productivity` — secondary interest: Finance

## Language
English (United States)

---

## Detailed description

```
Passive Investment Analyst turns your new tab into a quiet earnings calendar for the stocks you
actually follow.

Open a tab and you see what's coming: which of your holdings reports next, how
many days away it is, and whether it lands before the open or after the close.
When an executive or director buys their own company's stock on the open market,
that shows up too.
Anything reporting today or tomorrow is highlighted so you can't miss it. Below
that, a compact row of cards shows the day's move with a sparkline for each
ticker.

That's it. No feeds, no news, no notifications, no noise. Just the thing you'd
otherwise forget until it happened.

BUILT TO BE FAST
Passive Investment Analyst paints in a few milliseconds from a local cache, so a new tab never
stutters or flashes. Fresh data arrives in the background and updates in place —
you will never watch a spinner, and the layout never shifts under your cursor.

WORKS OFFLINE
Lost your connection? The last known prices and dates are still there. The
footer tells you plainly how stale they are instead of showing an error.

YOUR DATA STAYS YOURS
No account. No server. No tracking, analytics, or ads. Your API key never leaves
the device you enter it on. Your ticker list and settings live in your browser
and sync only through your own Chrome sync; ticker symbols are sent to the
market-data sources solely to fetch their prices and dates. There is no backend
to leak anything.

WHAT YOU GET
• Notable insider buying — only real open-market purchases, never RSU noise.
  Click any purchase to review the SEC filing it came from
• Earnings dates for up to 25 tickers, grouped by This week / Next week / Later
• Projected dates (estimated from a company's past reporting pattern) are clearly
  marked
• Today and tomorrow highlighted so imminent reports stand out
• Consensus EPS estimate where analysts publish one
• "Just reported" shows beat or miss for a few days after a company reports
• Prices with the day's change, refreshed every 15 minutes during market hours,
  plus a company logo and an intraday sparkline
• Pre-market and after-hours prices during those sessions
• Sort by biggest mover or by name
• Your list syncs between your own signed-in Chrome browsers
• Search by company name or ticker to add a stock
• Click any card to open it in Google Finance
• Turn any section off — earnings, insider buying, prices, extended hours
• Dark, light, or follow-your-system theme

NO SETUP
Install it and it works. No account, no API key, no signup. Three well-known
tickers are there on day one so the page is useful immediately — remove them in
one click.

If you'd rather use an official, documented data source, you can add your own
free Finnhub API key in settings and Passive Investment Analyst will switch to it. Entirely
optional, and the key stays on your device — it is never synced.

Not affiliated with Nasdaq, Zacks, Finnhub, Financial Modeling Prep, or Google.
Company names and logos are trademarks of their respective owners. Market data
comes from third parties, may be delayed or incomplete, and is provided for
information only. Nothing here is investment advice.
```

---

## Single purpose statement (required at submission)

```
Passive Investment Analyst replaces the new tab page with an upcoming-earnings calendar and price
overview for a stock watchlist the user defines. Every feature serves that one
purpose.
```

---

## Assets checklist

| Asset | Spec | Status |
|---|---|---|
| Store icon | 128×128 PNG | `icons/128.png` — ready |
| Small promo tile | 440×280 PNG | `store/promo-440x280.png` — exported from `promo-tiles.html` |
| Screenshots | 1280×800 PNG, 1–5 | `store/screenshots/` — captured from the real extension (recipe below to redo) |
| Marquee promo tile | 1400×560 PNG | optional, only for featuring |

### Screenshot recipe

Capture from your own install so the data is real:

1. Set the theme explicitly in settings (don't rely on system) so both light and
   dark shots are deliberate.
2. Size the browser window so the viewport is 1280×800.
3. Take shots of: the full page with earnings + cards, a card hover state, and
   the search overlay mid-typing.
4. Crop to exactly 1280×800.

Avoid showing your API key — it is masked in the settings panel, but don't
screenshot it revealed.
