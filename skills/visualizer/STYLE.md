# Visualizer Design System

Every visualization follows these rules. The goal is a clean, flat, refined aesthetic that feels native to the app — not decorative or glossy.

## Core Principles

1. **Flat design only** — no gradients, drop shadows, blur, or glow effects
2. **Color encodes meaning** — use color ramps semantically, not decoratively
3. **Viewport-fit** — every visualization fits its container without scrolling
4. **Refined borders** — `0.5px` lines, not heavy strokes
5. **Streaming-friendly** — structure files as: `<style>` → content HTML → `<script>`

## Color System

Use CSS custom properties for all colors — never hardcode hex values in markup. Define the palette in a `:root` block at the top of every file.

### Base Tokens

```css
:root {
  /* Backgrounds */
  --bg: #ffffff;
  --bg-secondary: #f8f7f5;
  --bg-tertiary: #f1efe8;

  /* Text */
  --text: #2c2c2a;
  --text-secondary: #5f5e5a;
  --text-tertiary: #888780;

  /* Borders */
  --border: rgba(0, 0, 0, 0.12);
  --border-emphasis: rgba(0, 0, 0, 0.25);

  /* Semantic */
  --info: #378add;
  --success: #639922;
  --warning: #ef9f27;
  --danger: #e24b4a;
}
```

### Color Ramps

Each ramp has 7 stops (50 → 900) from lightest to darkest. Use max 2–3 ramps per visualization.

**How to use stops:**
- **50**: Fill backgrounds (cards, highlighted regions)
- **200**: Light fills, area chart fills
- **400**: Mid-tone accents, chart fills
- **600**: Strokes, borders, subtitle text
- **900**: Title text, bold labels (on light backgrounds)

| Ramp | 50 | 200 | 400 | 600 | 800 | 900 |
|------|-----|------|------|------|------|------|
| **Purple** | #EEEDFE | #CECBF6 | #7F77DD | #534AB7 | #3C3489 | #26215C |
| **Teal** | #E1F5EE | #9FE1CB | #1D9E75 | #0F6E56 | #085041 | #04342C |
| **Coral** | #FAECE7 | #F5C4B3 | #D85A30 | #993C1D | #712B13 | #4A1B0C |
| **Blue** | #E6F1FB | #B5D4F4 | #378ADD | #185FA5 | #0C447C | #042C53 |
| **Green** | #EAF3DE | #C0DD97 | #639922 | #3B6D11 | #27500A | #173404 |
| **Amber** | #FAEEDA | #FAC775 | #EF9F27 | #854F0B | #633806 | #412402 |
| **Red** | #FCEBEB | #F7C1C1 | #E24B4A | #A32D2D | #791F1F | #501313 |
| **Gray** | #F1EFE8 | #D3D1C7 | #888780 | #5F5E5A | #444441 | #2C2C2A |

**Chart series defaults** — use these for data series in order:
```css
--series-1: #534AB7; /* purple-600 */
--series-2: #0F6E56; /* teal-600 */
--series-3: #D85A30; /* coral-400 */
--series-4: #185FA5; /* blue-600 */
--series-5: #639922; /* green-400 */
--series-6: #854F0B; /* amber-600 */
```

**Rules:**
- Text on colored backgrounds must use stop 800 or 900 from the same ramp — never black or gray
- Never use the same stop for both title and subtitle (weight alone doesn't create enough contrast)
- Use max 6 series colors per chart

## Typography

System font stack — no external fonts:

```css
font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
```

**Only two weights allowed: 400 (regular) and 500 (medium).** Never use 600 or 700.

| Element | Size | Weight | Notes |
|---------|------|--------|-------|
| Page title | 14px / 0.875rem | 500 | Single line, compact |
| Section heading | 14px / 0.875rem | 500 | |
| Subheading | 13px / 0.8125rem | 500 | |
| Body text | 13px / 0.8125rem | 400 | line-height: 1.5 |
| Small / caption | 11px / 0.6875rem | 400 | |
| KPI number | 20px / 1.25rem | 500 | |
| KPI label | 11px / 0.6875rem | 400 | |
| Minimum text | 11px | — | Never go below this |

**Text rules:**
- Sentence case only — never Title Case or ALL CAPS (except abbreviations like "KPI")
- Never use subtitles — keep titles to a single compact line
- SVG text: 12px for primary labels, 11px for subtitles

## Viewport Fitting

Visualizations are **widgets**, not web pages. They render inside iframes at fixed heights (450px in chat, flex-1 in modal). Every visualization must fit its container without a body-level scrollbar.

**Required base styles for every file:**

```css
html, body { height: 100%; overflow: hidden; }
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  display: flex;
  flex-direction: column;
  padding: 0.75rem;
}
h1 {
  font-size: 0.875rem;
  font-weight: 500;
  margin-bottom: 0.5rem;
}
```

**Main content area** — the primary chart, grid, or content region must fill remaining space:

```css
.main-content {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
```

**Rules:**
- `html, body` must have `height: 100%` and `overflow: hidden` — always
- `body` must use `display: flex; flex-direction: column` so children can use `flex: 1`
- Body padding is `0.75rem` — never `1.5rem`
- The main content area uses `flex: 1; min-height: 0` to fill remaining space
- Never let content flow past the viewport — if data is unbounded (tables, lists), only the data region scrolls with `overflow-y: auto`, not the body
- For multi-section layouts (KPIs + chart), prefer side-by-side or use minimal vertical gaps (`0.5rem`) — never stack sections with large margins
- No `.subtitle` elements — titles are single-line and compact

## Layout

**4px base grid** — all spacing should be multiples of 4px:

| Token | Value | Use for |
|-------|-------|---------|
| `--space-xs` | 4px | Tight gaps |
| `--space-sm` | 8px | Icon gaps, compact padding |
| `--space-md` | 12px | Grid gaps, component spacing |
| `--space-lg` | 16px | Section gaps |
| `--space-xl` | 24px | Large gaps (use sparingly) |

**Card pattern:**
```css
.card {
  background: var(--bg);
  border: 0.5px solid var(--border);
  border-radius: 12px;
  padding: 12px 16px;
}
```

No box-shadow. No elevation. Just a clean 0.5px border.

**Metric card pattern:**
```css
.metric-card {
  background: var(--bg-secondary);
  border: none;
  border-radius: 12px;
  padding: 12px;
}
```

**Grid layout:**
```css
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 8px;
}
```

Use `minmax(0, 1fr)` to prevent grid overflow.

## Borders & Strokes

- **Default border**: `0.5px solid var(--border)`
- **Emphasis border**: `0.5px solid var(--border-emphasis)`
- **Colored/featured border**: `2px solid` (semantic color)
- **SVG strokes**: `0.5px` for lines and dividers, `1.5px` for connectors and arrows
- **SVG rect corners**: `rx="4"` (subtle) to `rx="8"` (rounded)

## Prohibited

These effects cause visual glitches during streaming and break the flat aesthetic:

- **No gradients** — use flat solid fills
- **No box-shadow or drop-shadow** — use borders instead
- **No blur or backdrop-filter** — flat backgrounds only
- **No glow or neon effects**
- **No emoji** — use SVG paths or CSS shapes
- **No `position: fixed`** — breaks iframe layout
- **No font-weight above 500**

## Interactive Patterns

**Hover on data points**: Show tooltip, use `transition: all 0.15s ease`
**Hover on rows/cards**: `background: var(--bg-secondary)` with `0.15s` transition
**Inputs**: 36px height, `0.5px border var(--border)`, hover: `var(--border-emphasis)`, focus: `2px solid var(--info)`
**Buttons**: `background: transparent`, `0.5px border var(--border-emphasis)`, hover: `var(--bg-secondary)`, `border-radius: 8px`

### Tooltip pattern

```css
.tooltip {
  position: absolute;
  background: var(--text);
  color: var(--bg);
  padding: 6px 10px;
  border-radius: 6px;
  font-size: 12px;
  white-space: nowrap;
  pointer-events: none;
  z-index: 10;
  opacity: 0;
  transform: translate(-50%, -100%) translateY(-8px);
  transition: opacity 0.15s ease;
}
.tooltip.visible { opacity: 1; }
.tooltip::after {
  content: "";
  position: absolute;
  top: 100%;
  left: 50%;
  transform: translateX(-50%);
  border: 5px solid transparent;
  border-top-color: var(--text);
}
```

## Animations

Entry animations make visualizations feel polished. Play once on load.

**Easing**: `cubic-bezier(0.4, 0, 0.2, 1)`
**Duration**: 400ms for entries, 150ms for hover
**Stagger**: 50ms × index for sequential reveals

```css
@keyframes fadeIn {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes growUp {
  from { transform: scaleY(0); }
  to { transform: scaleY(1); }
}
@keyframes fillWidth {
  from { width: 0; }
  to { width: var(--target-width); }
}
@keyframes drawLine {
  from { stroke-dashoffset: var(--line-length); }
  to { stroke-dashoffset: 0; }
}
```

**Usage:** bars → growUp (transform-origin: bottom), lines → drawLine, cards → fadeIn, progress bars → fillWidth

## Number Formatting

Include in any template showing numeric data:

```js
function fmt(n) { return Number(n).toLocaleString(); }
function fmtCurrency(n, c = '$') { return c + Number(n).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 }); }
function fmtPct(n) { return Number(n).toFixed(1) + '%'; }
function fmtCompact(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toString();
}
```

Use `Math.round()` or `.toFixed()` to prevent floating-point artifacts like `3.0000000001`.

## Responsive

- Use `%` and `rem` for widths — no fixed pixel widths on containers
- Charts: `width: 100%`, height via `flex: 1; min-height: 0` (fills remaining space after title/legend)
- Tables: `overflow-x: auto` wrapper, table body gets `overflow-y: auto` for scroll containment
- Grid: `auto-fit` with `minmax()` for responsive columns
- SVG: always use `viewBox` and `width="100%"`, add `max-height: 100%` to prevent overflow

## SVG Guidelines

For freeform diagrams and illustrations:

```html
<svg width="100%" viewBox="0 0 680 H">
```

- Width `680` is the standard container width — keep it consistent
- Height `H` = lowest element y + 20px buffer
- Text: 14px for labels, 12px for subtitles
- Strokes: 0.5px for lines, 1.5px for arrows/connectors
- Rect corners: `rx="4"` to `rx="8"`
- All paths and polylines must have `fill="none"` to render as lines
- Use `text-anchor="middle"` for centered labels

**Arrow marker:**
```html
<defs>
  <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
    <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--text-secondary)"/>
  </marker>
</defs>
```

## File Structure

Always structure files in this order for streaming compatibility:

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Title</title>
<style>
  /* 1. CSS variables and base styles first */
  /* Keep style block under ~50 lines */
</style>
</head>
<body>
  <!-- 2. Content HTML -->
  <script>
    // 3. Scripts last — run after content is in DOM
  </script>
</body>
</html>
```

## Icons

Never use emoji. Use inline SVGs with `currentColor`:

```html
<svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <!-- path data -->
</svg>
```

Common paths:

| Icon | SVG content |
|------|-------------|
| Arrow up | `<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>` |
| Arrow down | `<line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/>` |
| Check | `<polyline points="20 6 9 17 4 12"/>` |
| X | `<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>` |
| Search | `<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>` |
| Settings | `<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>` |
| Users | `<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>` |
| Dollar | `<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>` |
| Calendar | `<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>` |

## Accessibility

- All interactive elements: `role` and `aria-label`
- Color contrast: 4.5:1 minimum
- Focus styles: `outline: 2px solid var(--info); outline-offset: 2px`
- Chart data should be available as a visually-hidden table for screen readers
