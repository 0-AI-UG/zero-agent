---
name: visualizer
description: >-
  Create interactive HTML visualizations — charts, dashboards, data tables,
  and reports. Use when the user wants to visualize data, build a report,
  or create an interactive display of results.
metadata:
  version: "1.0.0"
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
    - charts
    - dashboards
    - data
---

# Visualizer

Create polished, interactive HTML visualizations that render inline in the file viewer. Use this skill whenever the user wants to see data visually — charts, dashboards, KPI summaries, sortable tables, or any interactive report.

## Architecture Rules

Every visualization is a **single, self-contained HTML file** with all CSS and JS inline. The file renders inside a sandboxed iframe with `sandbox="allow-scripts"` — this means:

- No `localStorage`, `sessionStorage`, or `indexedDB`
- No `fetch()`, `XMLHttpRequest`, or external resource loading
- No `window.parent` access or `postMessage`
- No `window.open` or popups
- All styles and scripts must be inline — no external CDNs

All data must be embedded directly in the HTML file as JavaScript variables or JSON.

## Workflow

1. **Analyze the data** — Understand the shape, types, and ranges of the data to visualize
2. **Read STYLE.md** — Load `skills/visualizer/STYLE.md` via readFile for the design system
3. **Pick a template** — Read the appropriate template from `skills/visualizer/templates/`:
   - `chart.html` — Bar charts with legends and tooltips
   - `line-chart.html` — Line/area charts with multiple series
   - `donut-chart.html` — Donut/pie charts with labels
   - `dashboard.html` — Multi-card KPI layout with summary stats and charts
   - `data-table.html` — Sortable, filterable table with search
   - `comparison.html` — Side-by-side comparison layouts
   - `timeline.html` — Chronological event timelines
   - `progress.html` — Progress bars, meters, and completion tracking
   - `buttons.html` — Button styles, states, and interactive component patterns
4. **Customize** — Replace placeholder data with real data, adjust labels/colors/layout
5. **Write the file** — Save as `.html` in the `visualizations/` folder

## File Naming

Save all visualizations to `visualizations/{descriptive-name}.html`. Examples:
- `visualizations/monthly-revenue-chart.html`
- `visualizations/user-growth-dashboard.html`
- `visualizations/competitor-comparison-table.html`

## Guidelines

- Always follow the design system in STYLE.md for colors, typography, and spacing
- Include hover states and tooltips for data points
- Support dark mode via `prefers-color-scheme` media query
- Use relative units so visualizations work at various iframe widths
- Add `aria-label` attributes to interactive elements
- Keep file sizes reasonable — embed only the data needed for the visualization
- Never use emojis or HTML emoji entities — use inline SVGs for all icons (see STYLE.md Icons section)
