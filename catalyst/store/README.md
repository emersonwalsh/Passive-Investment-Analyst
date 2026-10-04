# Publishing Passive Investment Analyst

Everything needed for a Chrome Web Store submission.

| File | What it's for |
|---|---|
| `PRIVACY.md` / `privacy.html` | Privacy policy. **Must be hosted at a public URL** and that URL pasted into the listing. |
| `LISTING.md` | Name, descriptions, category, single-purpose statement — copy-paste ready. |
| `PERMISSIONS.md` | Per-permission justifications, which review asks for individually. |
| `SUBMIT.md` | **Start here**: every Developer Dashboard field, ready to paste. |
| `screenshots/`, `promo-440x280.png` | Store images at the required sizes, captured from the real extension by `tests/capture-assets.mjs`. |
| `promo-tiles.html` | Source for the promo tile. |

## How to submit

Follow **[`SUBMIT.md`](SUBMIT.md)**. It is a field-by-field sheet for the
Developer Dashboard with every value ready to paste.

The privacy policy is already hosted publicly on GitHub:
<https://github.com/emersonwalsh/Passive-Investment-Analyst/blob/main/catalyst/store/PRIVACY.md>.
`privacy.html` is the same policy as a standalone page, if you would rather host
it elsewhere (for example GitHub Pages).

### Building the upload

From the `catalyst/` directory:

```bash
zip -qrX ../passive-investment-analyst-$(python3 -c "import json;print(json.load(open('manifest.json'))['version'])").zip . -x "store/*" "README.md" ".*"
```

Run `node tests/run.mjs --all` first. The `--package` suite builds this same zip
and runs the real-browser tests against the unpacked result.

### Expect

First reviews for new developers often take several business days. The most
common rejection for an extension like this is a permission the reviewer cannot
map to the single purpose; `PERMISSIONS.md` maps each one to the exact source
file.
