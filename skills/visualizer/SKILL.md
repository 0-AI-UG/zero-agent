---
name: visualizer
description: >-
  Create interactive HTML visualizations — graphs, diagrams, flowcharts, state
  machines, charts, illustrations, and interactive explorations. Use proactively
  whenever a visual would clarify or enhance the response — not only when
  explicitly asked. Good candidates: explaining relationships, flows,
  architectures, comparisons, data, timelines, or any concept that is easier
  to grasp as a picture than as text.
metadata:
  version: "6.0.0"
  platform: visualizer
  login_required: false
  requires:
    env: []
    bins: []
  capabilities:
    - create
    - analyze
    - export
  tags:
    - visualization
    - graphs
    - diagrams
    - charts
    - interactive
---

# Visualizer

Create interactive HTML/SVG visualizations that render inline in chat. The
visualization renders incrementally as you write — the renderer streams your
output into a live iframe, so elements fade and blur in as they appear.

## Write Fragments, Not Full Documents

**Do not** write `<!doctype html>`, `<html>`, `<head>`, `<body>`, `<meta>`, or
`<title>`. The renderer provides all of that automatically, along with:

- A CSS reset (`box-sizing`, zeroed margins, `svg { display: block }`)
- Light + dark theme tokens scoped by `[data-theme]`, auto-synced to the app theme
- `body` background, font stack (DM Sans / Bricolage Grotesque), heading styles
- Global SVG arrow markers: reference with `marker-end="url(#viz-arrow)"` or `url(#viz-arrow-hl)` — **no need to declare `<defs>` / `<marker>` yourself**
- Entry animations (blur-in, scale-in, stroke-draw)
- Hover states on cards and nodes
- Resize observer that auto-sizes the iframe to content

A `.viz` file should start directly with your top-level element — a `<div>`,
`<svg>`, or an inline `<style>` block followed by structure. Save to
`visualizations/{descriptive-name}.viz`.

## Minimal Example

```html
<style>
  .grid { display: grid; gap: 12px; grid-template-columns: repeat(3, 1fr); }
</style>
<div class="grid">
  <div data-viz="card" data-viz-delay="1">
    <h3>Ingest</h3>
    <p data-viz="muted">Receives events</p>
  </div>
  <div data-viz="card" data-viz-delay="2">
    <h3>Process</h3>
    <p data-viz="muted">Transforms and validates</p>
  </div>
  <div data-viz="card" data-viz-delay="3">
    <h3>Store</h3>
    <p data-viz="muted">Writes to warehouse</p>
  </div>
</div>
```

## Semantic Attributes

Mark elements with `data-viz` to get automatic styling and animation:

| Attribute | Use On | You Get |
|-----------|--------|---------|
| `data-viz="card"` | Cards, panels | Background, border, radius, padding, blur-in animation, hover glow |
| `data-viz="node"` | Graph/diagram nodes | Same as card (in SVG: styles the child `<rect>`) |
| `data-viz="edge"` or `class="viz-edge"` | SVG lines/paths | Muted stroke, stroke-draw animation |
| `data-viz="badge"` | Tags, labels | Pill styling, scale-in animation |
| `data-viz="muted"` | Secondary text | Muted foreground color |
| `data-viz="highlight"` | Accented elements | Primary background + foreground |
| `data-viz="destructive"` | Error states | Destructive color |
| `class="viz-chart-1"` … `"viz-chart-5"` | Chart elements | Themed color + fill + stroke |
| `data-viz-delay="1"` … `"12"` | Any animated element | Staggered delay (40ms increments) |

## Layout Utilities

The renderer provides three quick layout classes — use them instead of writing
repetitive flexbox CSS:

- `.viz-stack` — vertical flex, 12px gap
- `.viz-row` — horizontal flex, centered, 12px gap
- `.viz-grid` — auto-fit grid, 180px min column, 12px gap

## What You Write vs What the Renderer Handles

**You write:**
- Your root element directly (`<div>`, `<svg>`, `<style>` — no doctype/html/body)
- Layout CSS: grid/flex, sizing, spacing, positioning
- SVG structure: `path` coords, `viewBox`, structural attributes
- Interactive JavaScript (drag, sort, collapse, force simulation)

**Do NOT write — the renderer provides these:**
- Doctype, html, head, body, meta, title
- CSS reset, `svg { display: block }`
- `color`, `background`, `font-family`, `border-radius` on `data-viz` elements
- `animation`, `transition`, `@keyframes`, `box-shadow`
- SVG arrowhead `<marker>` defs — just use `marker-end="url(#viz-arrow)"`

## CSS Variables

Reference these in your layout CSS when you need theme-aware colors for custom
elements:

`--viz-bg`, `--viz-fg`, `--viz-card`, `--viz-card-fg`, `--viz-primary`,
`--viz-primary-fg`, `--viz-muted`, `--viz-muted-fg`, `--viz-border`,
`--viz-destructive`, `--viz-chart-1` through `--viz-chart-5`, `--viz-radius`,
`--viz-ring`.

Example: `border: 1px solid var(--viz-border)`.

## Templates

Check `skills/visualizer/templates/` for reference implementations. Read and
adapt when close to what's needed.

**Graphs**: `node-graph.viz`, `flowchart.viz`, `state-machine.viz`, `dependency-tree.viz`, `mind-map.viz`
**Charts**: `chart.viz`, `line-chart.viz`, `donut-chart.viz`, `data-table.viz`
**Interactive**: `kanban.viz`, `timeline.viz`

## Guidelines

- Single fragment — no external resources (no CDN, no fetch, no storage)
- Sandboxed iframe: no `postMessage`, no `localStorage`, no network
- Content determines height — never set `height: 100%` or `overflow: hidden`
- SVG: use `viewBox` + `width="100%"` so aspect ratio determines height
- Graphs: make nodes draggable, highlight connected edges on hover
- Include tooltips on data points and nodes
- Format numbers with `toLocaleString()`, never show raw large numbers
- Max 5 words per label, max 4 items per horizontal row
- No emojis — use inline SVGs for icons
- **Streaming order**: Put inline `<style>` first, then structural HTML, then `<script>` last. Elements animate in as the parser reaches them
- Use `data-viz-delay="N"` for staggered reveals (cards in a grid appearing one by one)
