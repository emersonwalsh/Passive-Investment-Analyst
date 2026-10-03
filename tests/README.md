# Tests

These live **outside** `catalyst/` on purpose: that folder is exactly what gets
zipped for the Chrome Web Store, and nothing here should ship to users.

```bash
node tests/run.mjs            # fast and offline: parity in 6 timezones + service worker
node tests/run.mjs --chrome   # + the real extension in real Chrome, incl. worker lifetime
node tests/run.mjs --package  # + the real-browser suite against the zipped store upload
node tests/run.mjs --live     # + data accuracy against independent sources
node tests/run.mjs --all      # everything, on every cached Chrome for Testing build
```

Run `--all` before every store submission. The keyless data sources are
undocumented and can change without notice; `--live` is how you find out first.

| Suite | What it proves |
|---|---|
| `parity.test.mjs` | `boot.js` and `render.js` paint byte-identical markup in every state, so tabs never flash or reflow. Also: hostile API strings are escaped, projected dates are marked, surprises are stated proportionately. |
| `quotes.test.mjs` | A quote means different things in different sessions: during pre-market and after-hours Nasdaq's quote block is the EXTENDED trade, measured against that day's close. These pin the card to the regular price and the day's move in every session, including half-days. |
| `replay.test.mjs` | Real captured trading sessions replayed through the real quote code path, with the extension's fetch policy emulated at each sample's time, every card compared with CNBC at the same instant. Needs a capture in `tests/fixtures/local/` (gitignored — raw third-party data); record one with `capture-sessions.mjs`. |
| `worker.test.mjs` | The service worker's cost as well as its correctness: an add is cheap, unresolved dates don't become a request loop, the daily refresh can't starve, sync doesn't echo, only a deliberate refresh clears backoff, and the right requests happen in every market session. |
| `chrome.test.mjs` | The unpacked extension in real Chrome with real network: fresh install, first tab, warm tab (paint time, zero layout shift, no repaint), prices on screen vs CNBC, add and remove through the real UI, phone width, short screens. |
| `lifetime.test.mjs` | A 25-ticker refresh started by an alarm with no debugger attached finishes before Chrome's idle timeout can kill the worker. |
| `accuracy.test.mjs` | Prices vs CNBC, every card link vs Google Finance, confirmed earnings dates vs stockanalysis.com, insider buys vs the SEC Form 4 filings. |
| `capture-assets.mjs` | Not a test: regenerates the store screenshots and promo tile from the real extension. |

## Requirements

Node 22+ (uses the built-in `WebSocket`). The Chrome suites need Chrome for
Testing, because branded Google Chrome ignores `--load-extension` since v137:

```bash
npx @puppeteer/browsers install chrome@stable
```

or point `CHROME=/path/to/binary` at any Chromium build.

## Re-validating against live sessions

Run this before a release that touches quotes, and whenever Nasdaq's behaviour
is in doubt. It is the only test that sees the market in every session:

```bash
node tests/capture-sessions.mjs tests/fixtures/local/sessions-$(date +%Y-%m).jsonl
# leave it running across a full trading day (4am-8pm ET) and ideally a Monday
# morning, stop it, then:
node tests/replay.test.mjs
```

## Two traps these tests already hit

- **Headless Chrome's user-agent says `HeadlessChrome`, and Nasdaq resets the
  connection for it.** The harness presents the normal UA; without that, every
  network result is meaningless.
- **Never freeze `Date.now()`.** The request gate paces itself on elapsed time;
  a frozen clock deadlocks it. `installClock()` only moves forward and keeps
  ticking.
