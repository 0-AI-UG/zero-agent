---
name: presentation
description: >-
  Create professional slide decks and presentations. Use when the user wants
  to build a pitch deck, report, keynote, or any slide-based content that
  can be exported to PPTX.
metadata:
  version: "1.0.0"
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

Create polished slide decks that render inline as HTML and can be downloaded as PPTX. Use this skill whenever the user wants to build a presentation, pitch deck, report, or any slide-based content.

## Architecture Rules

Every presentation is a **single, self-contained HTML file** with all CSS and JS inline, saved with the `.slides` extension. The file renders inside a sandboxed iframe and can be converted to native PPTX.

Because of the PPTX conversion pipeline, strict CSS rules apply. Follow the **Supported CSS** and **Unsupported CSS** sections below exactly.

### Slide Structure

Each slide is a `<div class="slide">` at exactly **1920x1080px** with `overflow: hidden`. A multi-slide deck is one HTML file with multiple `.slide` divs separated by `page-break-before: always`.

### Boilerplate

Every `.slides` file must start with this structure:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=1920, initial-scale=1" />
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');

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
      font-family: 'Inter', sans-serif;
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
2. **Read STYLE.md** — Load `skills/presentation/STYLE.md` via readFile for the design system
3. **Pick templates** — Read relevant templates from `skills/presentation/templates/` for layout reference:
   - `title.html` — Hero title slide with subtitle
   - `content.html` — Heading with bullet points or paragraphs
   - `two-column.html` — Split layout for comparisons
   - `section.html` — Large text section divider
   - `data.html` — Charts and metrics using inline SVG
   - `full-deck.html` — Complete multi-slide example showing overall structure
4. **Compose the deck** — Write all slides in a single `.slides` file, combining and customizing template patterns
5. **Write the file** — Save as `.slides` in the `presentations/` folder

## File Naming

Save all presentations to `presentations/{descriptive-name}.slides`. Examples:
- `presentations/q1-revenue-report.slides`
- `presentations/product-launch-pitch.slides`
- `presentations/team-onboarding.slides`

## Supported CSS

These features survive PPTX conversion:

- **Backgrounds**: solid `background-color`, `linear-gradient()`, `radial-gradient()` (use 4+ stops for smooth gradients)
- **Layout**: flexbox and CSS Grid (positions captured via `getBoundingClientRect()`)
- **Fonts**: Google Fonts via `@import` — all weights 100-900
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

## Common Pitfalls

- **Always use Google Fonts** — system fonts don't embed weight variants, only binary bold
- **Use borders instead of box-shadow** — `border: 1px solid var(--border)` with lighter backgrounds for depth
- **Large text (72px+)** renders ~10% smaller in PPTX — size up slightly
- **Only one `background-image` per element** — use nested `<div>` elements for multiple layers
- **Leave 10-15% extra horizontal space** for text wrapping
- **Font weight 600** looks bolder in PPTX — consider using 500 instead
- **Small circles** (`border-radius: 50%`) on elements < 14px may render as squares
- **Never use emojis** — use inline SVGs for all icons

## Guidelines

- Always follow the design system in STYLE.md for colors, typography, and spacing
- Use absolute positioning within `.slide` divs — the canvas is always exactly 1920x1080
- Keep content generous with whitespace — slides should breathe
- Data should be embedded directly as CSS or inline HTML, not JavaScript variables (since PPTX conversion captures the DOM, not JS output)
- Prefer CSS Grid or flexbox for layouts within slides — positions are captured correctly
- Include `aria-label` attributes on key elements for accessibility
