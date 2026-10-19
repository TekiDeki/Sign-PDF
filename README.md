# Sign PDF

Put your signature on a PDF in the browser. The document is read in the tab,
nothing is uploaded, there is no account, and the page works offline once it
has loaded.

Live: <https://freehtml.dev/sign> · Source: <https://github.com/TekiDeki/Sign-PDF>

## What it does

- **Open** a PDF by dropping it on the page or choosing it from the device.
- **Draw** a signature with the mouse, the trackpad or a finger, in black, blue
  or red. Empty space around the ink is cut away before it is used.
- **Type** a name in a script or a serif face, for people who would rather not
  draw with a mouse.
- **Upload** a photo of a signature from paper, with the white background made
  transparent in one pass.
- **Place** it anywhere: a click puts it on a page, dragging moves it, and the
  four corner handles resize it without stretching the picture.
- **Add the date**, in the same way, if the form has a line for it.
- **Download** a normal PDF with the signature drawn into the page itself, not
  added as a layer that can be moved or deleted afterwards.
- **Undo** as much as you want, forty steps back.
- **Dark theme**, remembered between visits, or the system one on the first visit.
  The document page stays white on purpose: it has to look like the printed page.

The signature itself is remembered in `localStorage`, so the second document of
the day takes three seconds. The document is never stored: close the tab and it
is gone.

Everything runs in this tab. There is no server, no upload and no analytics.

## What it does not do

- **No sending documents to other people to sign.** That needs a server, an
  account and an audit trail, which is exactly what this tool is not.
- **No certificate based digital signature.** This is a simple electronic
  signature, enough for a permission slip or an internal form, not for anything
  that has to be verified against a qualified certificate.
- **No text editing.** The PDF keeps every page as it is; only the signature is
  added.

These limits are on the page too, in all four languages, so nobody finds out
after signing forty pages.

## Using it

1. Drop the PDF on the box.
2. Draw, type or upload a signature in the panel.
3. Click the page where it belongs. Drag to move it, pull a corner to resize.
4. Press *Download the signed PDF*.

On a phone the panel comes first, and after the document opens the page scrolls
down to the first sheet.

## Development

```bash
python3 build.py                  # writes index.html, single file, deterministic
node tests/logic_test.cjs                      # 64 checks: geometry, ink, real PDF work
python3 tests/ui_test.py                       # 133 checks on Chromium
BROWSER=firefox python3 tests/ui_test.py       # the same on Firefox
BROWSER=webkit  python3 tests/ui_test.py       # the same on WebKit, the Safari engine

Every pass covers a desktop at 1280x900, a touch tablet at 820x1180 and a touch
phone at 390x844. The theme is checked too: the toggle, the saved choice, the
reload, and the fact that the document page stays white in dark mode.
Every download is read back through pdf-lib and inspected:
page count, and how many images are actually drawn on each page, so a signature
that only looks placed on screen is caught.
```

`tests/logic_test.cjs` needs the library installed next to the repo:

```bash
npm install pdf-lib@1.17.1
NODE_PATH=./node_modules node tests/logic_test.cjs
```

The fixtures can be rebuilt with `node tests/make_fixtures.cjs`.

## Files

| Path | What it is |
|---|---|
| `src/template.html` | the page skeleton, with the script slots |
| `src/styles.css` | all the styling, no framework |
| `src/engine.js` | geometry, ink trimming and the PDF write, no DOM |
| `src/app.js` | the interface: drawing, placement, language, download |
| `src/vendor/pdf.min.js` | PDF.js 3.11.174, Apache-2.0, for rendering pages |
| `src/vendor/pdf.worker.min.js` | the same, as the worker, inlined as a text block and started from a blob |
| `src/vendor/pdf-lib.min.js` | pdf-lib 1.17.1, MIT, for writing the file |
| `src/i18n/locales.json` | EN, RO and SR Latin; SR Cyrillic is generated |
| `build.py` | inlines everything into `index.html` and checks the rules |
| `index.html` | the built page, committed, served by GitHub Pages |
| `sw.js` | offline shell |
| `tests/fixtures/` | a three page contract, a one page slip, an invoice, an encrypted PDF, a corrupted one and two signatures |
| `screenshots/` | desktop, phone, the signed page and the dark theme, from this build |

## Languages

Four: English, Romanian, Serbian Latin and Serbian Cyrillic. Romanian and
Serbian Latin are written by hand; Serbian Cyrillic is produced by the build
from the Latin one, so the two can never disagree. The build refuses a missing
key, a placeholder that does not match between languages, an em dash, an en
dash or a byte order mark.

The language is detected from `navigator.language`, remembered in
`localStorage`, and changing it also relabels the page numbers.

## How the geometry works

Placements are stored in page space, from 0 to 1, with the origin in the top
left corner. Nothing is stored in pixels, so the same placement looks the same
at every zoom level and on every screen.

The image keeps its own proportions: since the width and the height are
fractions of two different page dimensions, the page ratio is divided by the
picture ratio. A 4:1 signature on an A4 page therefore covers about 2.8 percent
of the page height when it covers 30 percent of the width. The tests check the
drawn box against the picture ratio, so a wrong formula cannot slip through a
build that still looks fine on one screen size.

## Limits worth knowing

- The page renders the first 60 pages. Placements are only allowed on pages that
  are on screen, which is why the cap is stated on the page itself.
- A scanned book of 80 MB will not open on a phone. The limit is stated before
  anything is read.
- The PDF is not modified in place: the output is a new file, downloaded with
  the name you choose.
- Password protected PDFs are refused, not unlocked.

## Licence

Apache-2.0. The bundled pdf-lib is MIT, by Andrew Dillon. The bundled PDF.js is
Apache-2.0, by Mozilla. Both notices are in `src/vendor/`.

Built by [TekiDeki](https://freehtml.dev). Free, no account, no tracking.
If it saved you some time: <https://paypal.me/TekiDeki>
