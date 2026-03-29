---
name: visualizer
description: >-
  Create interactive HTML visualizations — graphs, diagrams, flowcharts, state
  machines, charts, illustrations, and interactive explorations. Use when the
  user wants to see something visually.
metadata:
  version: "4.0.0"
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

Create interactive HTML/SVG visualizations that render inline in chat.

## Rules

- Single self-contained `.viz` file — all CSS/JS inline, no external resources
- Sandboxed iframe: no storage, no fetch, no postMessage, no CDNs
- Flat design only — no gradients, shadows, blur. Light mode only
- Content determines height — never set `height: 100%` or `overflow: hidden` on body
- SVG: use `viewBox` + `width="100%"` so aspect ratio determines height
- Read `skills/visualizer/STYLE.md` before building for colors, typography, and patterns
- Save to `visualizations/{descriptive-name}.viz`

## Templates

Check `skills/visualizer/templates/` for reference implementations. Read and adapt when close to what's needed.

**Graphs**: `node-graph.viz`, `flowchart.viz`, `state-machine.viz`, `dependency-tree.viz`, `mind-map.viz`
**Charts**: `chart.viz`, `line-chart.viz`, `donut-chart.viz`, `data-table.viz`
**Interactive**: `kanban.viz`, `timeline.viz`

If no template fits, build freeform from HTML/CSS/JS/SVG.

## Guidelines

- Graphs: make nodes draggable, highlight connected edges on hover
- Include hover states and tooltips on data points and nodes
- Use entry animations — see STYLE.md for patterns
- Format numbers with `toLocaleString()`, never show raw large numbers
- Max 5 words per label, max 4 items per horizontal row
- No emojis — use inline SVGs for icons
