# Publishing Passive Investment Analyst

Everything needed for a Chrome Web Store submission.

| File | What it's for |
|---|---|
| `PRIVACY.md` / `privacy.html` | Privacy policy. **Must be hosted at a public URL** and that URL pasted into the listing. |
| `LISTING.md` | Name, descriptions, category, single-purpose statement — copy-paste ready. |
| `PERMISSIONS.md` | Per-permission justifications, which review asks for individually. |
| `promo-tiles.html` | Promo tiles at exact pixel size; screenshot to export. |

## Order of operations

**1. Host the privacy policy.** GitHub Pages is the zero-cost route: push
`privacy.html` to a repo, enable Pages, use the resulting URL. The Web Store
rejects submissions that declare data handling without a reachable policy URL,
and Passive Investment Analyst does store a user-supplied API key, so this is required rather than
optional.

**2. Export the promo tile.** Open `promo-tiles.html`, screenshot the 440×280
tile, crop to exactly 440×280. The marquee tile is only needed if you want to be
eligible for featuring.

**3. Capture screenshots** at 1280×800 from your own install — see the recipe in
`LISTING.md`. Real data looks better than mock data, and reviewers notice.

**4. Zip the extension.** From the `catalyst/` directory, include everything
*except* this `store/` folder and `README.md`:

```bash
cd "path/to/catalyst" && zip -r ../catalyst.zip . -x "store/*" "README.md" ".*"
```

**5. Submit** at <https://chrome.google.com/webstore/devconsole>. There is a
one-time $5 developer registration fee — that is the only cost in the entire
project.

**6. Fill in the data-handling disclosures.** Declare that you collect
"Authentication information" (the user's API key), that it is stored locally and
transmitted only to the issuing service, and that it is not sold or used for
anything unrelated to the single purpose. Answering these accurately is what
keeps review short.

## Expect

First review typically takes a few business days. The most common rejection for
an extension like this is a permission the reviewer can't map to the stated
single purpose — `PERMISSIONS.md` is written to pre-empt that by pointing at the
exact source file for each one.
