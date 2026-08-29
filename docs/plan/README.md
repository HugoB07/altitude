# Development plan - sources

Altitude's design document (56 A4 pages, 20 sections), authored as HTML and rendered
to PDF through headless Chrome.

## Layout

| Path                 | Role                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `parts/*.html`       | Tracked sources. `00-head.html` carries the CSS, the cover and the table of contents; the rest are the numbered sections. |
| `build-html.mjs`     | Concatenates `parts/` into a single HTML file, in natural numeric order.                                                  |
| `build-pdf.mjs`      | Renders that HTML to PDF through headless Chrome driven over CDP. No npm dependencies.                                    |
| `altitude-plan.html` | Generated concatenation - **not tracked**.                                                                                |
| `*.pdf`              | Generated output - **not tracked**.                                                                                       |

Only the sources are versioned. Both generated files are rebuilt on demand, so they
stay out of git history rather than landing as a 3 MB binary blob on every edit.

## Rebuild

```bash
cd docs/plan
node build-html.mjs
node build-pdf.mjs
```

`build-html.mjs` writes `altitude-plan.html`, sorting `parts/` with a natural numeric
comparison - so `10-` correctly follows `2-`, which a plain shell glob would get wrong.

`build-pdf.mjs` takes an optional input and output path, defaulting to
`altitude-plan.html` and `Altitude-Dev-Plan.pdf`. It looks for Chrome at
`C:\Program Files\Google\Chrome\Application\chrome.exe`; override that with the
`CHROME_PATH` environment variable on other platforms.

```bash
node build-pdf.mjs altitude-plan.html ../../out/plan.pdf   # explicit paths
CHROME_PATH=/usr/bin/chromium node build-pdf.mjs           # Linux
```

The renderer waits for `document.fonts.status === "loaded"` before printing, so the
first build needs network access to fetch the Google Fonts stylesheet. Offline, the
document still renders correctly using the fallback stacks.

## Editing

Edit the relevant file in `parts/`, never `altitude-plan.html` - it is overwritten on
every build. All CSS lives in `parts/00-head.html`.

Adding a section means adding a numbered file to `parts/`; no build change is needed.
Keep the numeric prefix, since it is what fixes the order.

Layout constraints to respect:

- A4 content width is 182 mm. Nothing may overflow it; wide tables use the `.tight`
  class to drop to a smaller font size.
- Blocks that must not split across pages carry `page-break-inside: avoid` (already
  applied to `table`, `.box`, `.card`, `figure` and `pre`).
- Diagrams are inline SVG using only the fonts the document already loads.
- Every section opens with `<section class="sec">`, which forces a page break.

### Checking for overflow

The most common regression is a table or diagram wider than the printable area, which
Chrome silently clips. To check, load the concatenated HTML in a browser at a 657 px
viewport with print media emulated, and confirm `document.body.scrollWidth` still
equals the viewport width.
