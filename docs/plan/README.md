# Development plan — sources

Altitude's design document (56 A4 pages, 20 sections).

> The document itself is written in French. Everything repository-facing —
> README, code comments, commit messages, ADRs — is English.

## Layout

| Path | Role |
|------|------|
| `parts/*.html` | Tracked sources. `00-head.html` carries the CSS and the cover; the rest are sections. |
| `build-pdf.mjs` | PDF rendering through headless Chrome driven over CDP. No npm dependencies. |
| `altitude-plan.html` | Generated concatenation — **not tracked**. |
| `*.pdf` | Generated output — **not tracked**. |

## Rebuild

```bash
cd docs/plan
cat parts/*.html > altitude-plan.html
node build-pdf.mjs
```

Both arguments are optional and default to `altitude-plan.html` and
`Altitude-Plan-de-developpement.pdf`. Chrome is looked up at
`C:\Program Files\Google\Chrome\Application\chrome.exe`; override it with the
`CHROME_PATH` environment variable on other platforms.

Files in `parts/` are concatenated in filename order, hence the numeric prefix.

## Editing

Edit the relevant section file, never `altitude-plan.html` — it is overwritten on
every build. All CSS lives in `parts/00-head.html`.

Layout constraints to respect:

- A4 content width is 182 mm. Nothing may overflow it; wide tables use the `.tight`
  class to drop to a smaller font size.
- Blocks that must not be split across pages carry `page-break-inside: avoid`
  (already applied to `table`, `.box`, `.card`, `figure` and `pre`).
- Diagrams are inline SVG and use only the fonts already loaded by the document.
