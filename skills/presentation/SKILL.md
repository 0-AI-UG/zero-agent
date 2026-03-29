---
name: presentation
description: >-
  Create slide decks and presentations. Use when the user wants to build a
  pitch deck, report, keynote, or any slide-based content that can be exported
  to PPTX.
metadata:
  version: "2.0.0"
  platform: presentation
  login_required: false
  requires:
    env: []
    bins: []
  capabilities:
    - create
    - export
  tags:
    - slides
    - presentation
    - pptx
    - deck
    - pitch
---

# Presentation

Create slide decks that render as HTML and can be exported to PPTX/PNG via code execution. Use this skill whenever the user wants to build a presentation, pitch deck, report, or any slide-based content.

## Architecture Rules

Every presentation is a **single, self-contained HTML file** with all CSS and JS inline. The file can be converted to PPTX via the `@0-ai/slide-gen` package using `bash` to run `bun`.

### Slide Structure

Each slide is a `<div class="slide">` at exactly **1920x1080px** with `overflow: hidden`. A multi-slide deck is one HTML file with multiple `.slide` divs separated by `page-break-before: always`.

### Boilerplate

Every presentation file must start with this structure:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=1920, initial-scale=1" />
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      background: #000;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    .slide {
      position: relative;
      width: 1920px;
      height: 1080px;
      overflow: hidden;
    }

    .slide + .slide {
      page-break-before: always;
    }
  </style>
</head>
<body>
  <div class="slide"><!-- content --></div>
</body>
</html>
```

## Workflow

1. **Analyze the content** — Understand the topic, key messages, and how many slides are needed
2. **Compose the deck** — Write all slides in a single HTML file following the supported CSS rules below
3. **Write the file** — Save as `.html` in its own folder under `presentations/`
4. **Render & review** — Write a render script and run it via `bash` to generate PNGs, then visually inspect and iterate
5. **Export** — Ask the user if they'd like a PPTX. If yes, write and run an export script via `bash`

## File Naming

Each presentation gets its own folder under `presentations/`. Examples:
- `presentations/q1-revenue-report/q1-revenue-report.html`
- `presentations/product-launch-pitch/product-launch-pitch.html`
- `presentations/team-onboarding/team-onboarding.html`

## Setup

Run these two commands before any conversion code:

```
bash: bun add @0-ai/slide-gen
bash: bunx playwright install --with-deps chromium 2>&1 | tail -5
```

**`@0-ai/slide-gen` is the only package you need.** It handles PNG rendering, PPTX export, and PDF generation internally. Do NOT install other packages like `pptxgenjs`, `playwright`, or `puppeteer` — they are unnecessary and will cause errors.

## Visual Iteration

After writing or editing a presentation file, render it to PNG so you can visually verify the result. First write the render script via `writeFile`, then run it:

```js
// render-preview.js
import { convertHtmlBuffers } from "@0-ai/slide-gen";
import { readFileSync, writeFileSync } from "node:fs";

const html = readFileSync("presentations/my-deck/my-deck.html", "utf-8");
const result = await convertHtmlBuffers({ html, noPdf: true, noPptx: true, noPng: false });

for (const [i, buf] of result.pngBuffers.entries()) {
  writeFileSync(`presentations/my-deck/preview-${i + 1}.png`, buf);
}
console.log(`Rendered ${result.pngBuffers.length} slide(s)`);
```

```
bash: bun run presentations/my-deck/render-preview.js
```

Then read the generated PNG files with `readFile` to see what each slide looks like. If the layout, spacing, or content needs adjustment, edit the HTML file and re-render until the result looks good.

## PPTX Export

After the user approves the slides, ask if they'd like to download as PPTX. If yes, write and run the export script:

```js
// export-pptx.js
import { convertHtmlBuffers } from "@0-ai/slide-gen";
import { readFileSync, writeFileSync } from "node:fs";

const html = readFileSync("presentations/my-deck/my-deck.html", "utf-8");
const result = await convertHtmlBuffers({ html, noPdf: true, noPng: true, noPptx: false });
writeFileSync("presentations/my-deck/my-deck.pptx", result.pptxBuffer);
console.log("PPTX exported");
```

```
bash: bun run presentations/my-deck/export-pptx.js
```

## Supported CSS

These features survive PPTX conversion:

- **Backgrounds**: solid `background-color`, `linear-gradient()`, `radial-gradient()` (use 4+ stops for smooth gradients)
- **Layout**: flexbox and CSS Grid (positions captured via `getBoundingClientRect()`)
- **Fonts**: Google Fonts via `@import` - all weights 100-900
- **Borders**: individual sides, colors, widths >= 1px
- **`border-radius`**: single uniform value only (not per-corner)
- **Opacity**: fully supported, accumulated from ancestors
- **CSS variables**: resolved by the browser before extraction
- **Rotation**: `transform: rotate()` only
- **`::before` / `::after`**: position, size, background only (no text content)
- **Text**: `font-size` (4-400pt), `font-weight`, `font-style`, `color`, `letter-spacing`, `text-transform`, `text-align`, `line-height`
- **Elements**: `<pre>` blocks (whitespace preserved), `<br>` tags, `<img>` (rasterized as PNG), inline SVG (screenshot), `background-image: url()` (single image)

## Unsupported CSS (Silently Ignored in PPTX)

Do NOT use these for anything visually important:

- **Effects**: `box-shadow`, `text-shadow`, `filter`, `backdrop-filter`, `clip-path`, `mask`, `outline`
- **Text decoration**: `underline`, `strikethrough`, `text-indent`, `word-spacing`
- **Transforms**: `scale()`, `skew()`, `translate()`, `perspective` (only `rotate()` works)
- **Gradients**: `conic-gradient()`, `repeating-*-gradient()`
- **Layout**: `position: relative` offsets, `position: sticky/fixed`, CSS columns, float
- **Other**: multiple `background-image` layers, per-corner `border-radius`, `::before`/`::after` text content, CSS animations/transitions

## Critical Rules

- **Always use the exact render/export script templates** from this skill. Do not write custom conversion logic.
- **Never install additional packages** for rendering or export. `@0-ai/slide-gen` handles everything.
- **Slides must be 1920x1080px**. No other dimensions.

## Common Pitfalls

- **Use Google Fonts** - system fonts don't embed weight variants, only binary bold
- **Use borders instead of box-shadow** - for visual depth
- **Large text (72px+)** renders ~10% smaller in PPTX - size up slightly
- **Only one `background-image` per element** - use nested `<div>` elements for multiple layers
- **Leave 10-15% extra horizontal space** for text wrapping differences
- **Font weight 600** looks bolder in PPTX - consider using 500 instead
- **Small circles** (`border-radius: 50%`) on elements < 14px may render as squares
- **Never use emojis** - use inline SVGs for all icons
- Data should be embedded directly as CSS or inline HTML, not JavaScript variables (PPTX conversion captures the DOM, not JS output)
