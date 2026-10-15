# Redaction Audit

Drop a PDF. See if its black boxes actually hide anything — and fix them for real.

Live: https://gfxroy.github.io/redaction-audit/

![screenshot](docs/screenshot.png)

Drop a PDF. The page lists text that is still in the file under a black box, a white box, or a redaction annotation, and draws those boxes on a thumbnail of the page. Fix rebuilds a PDF with those covers burned into the pixels, strips the document info, and checks the result.

## How it works

The check runs in the browser. pdf.js reads the file locally. A worker, the cmap files, and the standard fonts are bundled with the site.

Filled rectangles come from the page's operator list, not from a search for the words "redacted". The walker keeps a graphics-state stack: `q`/`Q`, the current transformation matrix, and the fill color in gray, RGB, or CMYK. pdf.js 5 reports a path as one `constructPath` whose first argument is the paint operator (`fill`, `eoFill`, and the fill-and-stroke variants) and whose coordinates are still in user space, so the current matrix is applied here. A rectangle is four lines, or the rectangle operator in older lists. A fill is kept when its luminance is under 0.2 and its area is at least 16 square points. Luminance is `0.2126 R + 0.7152 G + 0.0722 B`. A fill at or above 0.9 is a whiteout. Strokes, marks thinner than 2 points, and fills with opacity under 0.5 are ignored. The same walk records each `showText`, so a box counts only when it is painted after the text.

Text comes from `getTextContent`. Each item is split into one box per character, sharing the item's width equally. The box sits on the baseline, 80% of the font size above it and 20% below, along the text matrix, so a rotated run stays with its glyphs. A character leaks when a later dark or white fill covers more than half of that box. Square and highlight annotations count when they are black. A redaction annotation with no burned-in appearance counts at any overlap. One character is reported once, under the topmost cover, and the characters under a cover are joined back into a string.

pdf.js sometimes glues adjacent `showText` runs on the same line into one item. That item is placed at the first run's position in the stream.

Fix rebuilds the file with pdf-lib. Every page that has a dark box, a whiteout, or one of those annotations is drawn to a canvas at 200 DPI, then each cover polygon is painted into the pixels (black, or white for a whiteout). Annotations are not in the page content, so the burn is what actually hides them. Pages with no covers are copied as vectors, which keeps their text layer. The info dictionary (title, author, producer, dates, and the rest) and the catalog XMP stream are removed. The new file is opened with pdf.js and audited again. The page says the check passed only when that second audit finds nothing.

## Limitations

- A black bar that is only an image is not detected. The walker looks at filled paths and at Square, Highlight, and Redact annotations.
- Opacity under 0.5 is ignored. Clipping paths and holes in even-odd fills are ignored.
- Glyph boxes split a run's width equally. On a proportional font the boxes are a little wider or narrower than the real glyphs.
- Colors with luminance from 0.2 up to 0.9 are ignored. A gray box in that range is not treated as a cover.
- Encrypted PDFs are refused. Remove the password first.
- Rasterizing a page replaces its whole text layer with a 200 DPI image. Text on that page cannot be selected afterward, and small type can look soft. A joined text item uses the first run's paint order, so a box drawn between two runs that pdf.js merged can be blamed for characters that were painted later.
- The whole file is held in memory in the tab. A very large PDF can run the browser out of memory.

## Development

```bash
npm install
npm test
npm run dev
npm run build
```

`npm run build:pages` builds with the GitHub Pages base path `/redaction-audit/`.
