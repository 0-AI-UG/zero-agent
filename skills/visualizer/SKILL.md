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
  version: "5.0.0"
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

Create interactive HTML/SVG visualizations that render inline in chat. The visualization renders incrementally as you write — the user sees it being "painted" in real time with fade-in and scale-up animations.

## How It Works

You write **structural HTML + layout CSS**. The renderer automatically injects:
- Colors and typography (themed to the app)
- Entry animations (fade-in, scale-up) on semantic elements
- Hover states and transitions

Use `data-viz` attributes to mark elements for automatic styling and animation.

## Rules

- Single self-contained `.viz` file — layout CSS and JS inline, no external resources
- Sandboxed iframe: no storage, no fetch, no postMessage, no CDNs
- Content determines height — never set `height: 100%` or `overflow: hidden` on body
- SVG: use `viewBox` + `width="100%"` so aspect ratio determines height
- Save to `visualizations/{descriptive-name}.viz`

## Semantic Attributes

Mark elements with `data-viz` to get automatic styling and animation from the renderer:

| Attribute | Use On | You Get |
|-----------|--------|---------|
| `data-viz="card"` | Cards, panels | Background, border, border-radius, fade-in animation, hover glow |
| `data-viz="node"` | Diagram/graph nodes | Same as card (semantically distinct) |
| `data-viz="edge"` or `class="viz-edge"` | SVG lines/paths | Muted stroke color, stroke-width |
| `data-viz="badge"` | Tags, labels | Pill styling, scale-in animation |
| `data-viz="muted"` | Secondary text | Muted foreground color |
| `data-viz="highlight"` | Accented elements | Primary background + foreground |
| `data-viz="destructive"` | Error states | Destructive color |
| `class="viz-chart-1"` through `"viz-chart-5"` | Chart elements | Themed color + fill + stroke |
| `data-viz-delay="1"` through `"8"` | Any animated element | Staggered animation delay (50ms increments) |

## What You Write vs What the Renderer Handles

**You write:**
- HTML structure with `data-viz` attributes
- Layout CSS: `display: flex/grid`, `gap`, `padding`, `margin`, `width`, `height`, `position`
- `font-size`, `font-weight` (sizing is layout)
- SVG structure: `path` coordinates, `viewBox`, structural attributes
- JavaScript for interactivity (drag, sort, collapse, force simulation)

**Do NOT write — the renderer provides these:**
- `color`, `background-color`, `background` (use `data-viz` attributes instead)
- `font-family` (provided automatically)
- `border-radius` on `data-viz` elements (provided automatically)
- `animation`, `transition`, `@keyframes` (provided automatically)
- `box-shadow` (provided automatically on hover)

## CSS Variables

The renderer injects `--viz-*` CSS variables you can reference in layout CSS when needed:

`--viz-bg`, `--viz-fg`, `--viz-card`, `--viz-card-fg`, `--viz-primary`, `--viz-primary-fg`, `--viz-muted`, `--viz-muted-fg`, `--viz-border`, `--viz-destructive`, `--viz-chart-1` through `--viz-chart-5`, `--viz-radius`, `--viz-ring`

Use these for custom elements that don't fit the semantic attributes, e.g. `border: 1px solid var(--viz-border)`.

## Templates

Check `skills/visualizer/templates/` for reference implementations. Read and adapt when close to what's needed.

**Graphs**: `node-graph.viz`, `flowchart.viz`, `state-machine.viz`, `dependency-tree.viz`, `mind-map.viz`
**Charts**: `chart.viz`, `line-chart.viz`, `donut-chart.viz`, `data-table.viz`
**Interactive**: `kanban.viz`, `timeline.viz`

If no template fits, build freeform from HTML/CSS/SVG/JS.

## Guidelines

- Graphs: make nodes draggable, highlight connected edges on hover
- Include tooltips on data points and nodes
- Format numbers with `toLocaleString()`, never show raw large numbers
- Max 5 words per label, max 4 items per horizontal row
- No emojis — use inline SVGs for icons
- **Incremental rendering**: Put `<style>` (layout only) and structural HTML early, then data/content elements, then `<script>` last. Elements animate in as they appear during streaming
- Use `data-viz-delay` for staggered reveals (e.g. cards in a grid appearing one by one)
