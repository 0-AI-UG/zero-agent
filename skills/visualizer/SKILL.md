---
name: visualizer
description: >-
  Create interactive HTML visualizations — charts, diagrams, illustrations,
  interactive explanations, mockups, and dashboards. Use when the user wants
  to see something visually, understand a system, explore data, or prototype a UI.
metadata:
  version: "3.0.0"
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
    - diagrams
    - dashboards
    - interactive
    - illustration
    - data
---

# Visualizer

Create polished, interactive HTML or SVG visualizations that render inline in the chat. Use this skill whenever the user wants to **see** something — whether that's data in a chart, a system explained as a diagram, an animated illustration, an interactive exploration, or a UI mockup.

## Architecture Rules

Every visualization is a **single, self-contained file** with all CSS and JS inline. It renders inside a sandboxed iframe with `sandbox="allow-scripts"`:

- No `localStorage`, `sessionStorage`, or `indexedDB`
- No `fetch()`, `XMLHttpRequest`, or external resource loading
- No `window.parent` access or `postMessage`
- All styles and scripts must be inline — no external CDNs
- No gradients, shadows, or blur filters that flash during DOM streaming — use flat, solid fills
- Light mode only — no `prefers-color-scheme` needed

All data and content must be embedded directly in the file.

## How to Decide What to Build

Route on **intent**, not keywords. Ask: what is the user trying to accomplish?

### Chart — "Show me the data"
Data visualization. The user has numbers and wants to see patterns, comparisons, or trends.
- Bar, line, area, donut, scatter, heatmap, treemap, funnel charts
- Dashboards combining KPIs with charts
- Sortable data tables
- **Reference templates**: `chart.viz`, `line-chart.viz`, `area-chart.viz`, `donut-chart.viz`, `scatter-plot.viz`, `heatmap.viz`, `treemap.viz`, `funnel-chart.viz`, `metric-cards.viz`, `dashboard.viz`, `data-table.viz`

### Diagram — "Explain how this works"
Structural or conceptual visuals. The user wants to understand a system, process, or relationship.
- Flowcharts, architecture diagrams, data flow diagrams
- Org charts, network topology, dependency graphs
- Process flows with steps and arrows
- Concept maps showing relationships
- **Build freeform** using SVG boxes, arrows, and labels. No template needed — compose from primitives.
- Keep text short: max 5 words per label, max 4 boxes per horizontal row
- Use consistent box sizes and spacing

### Interactive — "Let me explore this"
The user wants to manipulate, experiment, or play with something.
- Sliders that change values and update visuals in real-time
- Toggles that show/hide layers or switch views
- Calculators, converters, decision trees
- Animated simulations (orbital systems, physics, sorting algorithms)
- Kanban boards, timelines, progress trackers
- **Reference templates**: `kanban.viz`, `timeline.viz`, `progress.viz`, `comparison.viz`
- Use event listeners, `requestAnimationFrame` for animations, and state management in vanilla JS

### Illustration — "Show me what it looks like"
Visual art and representational graphics. The user wants to see a thing, not just data about it.
- Solar system, molecular structures, anatomical diagrams
- Maps, landscapes, abstract art
- Labeled diagrams with hover-to-highlight regions
- Animated SVG illustrations
- **Build freeform** using SVG paths, circles, text, and CSS animations
- Focus on visual clarity over photorealism — clean shapes, clear labels, purposeful color

### Mockup — "Design this UI"
UI prototyping. The user wants to see what a page, component, or app could look like.
- Landing pages, settings screens, dashboards
- Component libraries, form layouts
- Mobile and desktop layouts
- **Reference template**: `buttons.viz` (for component patterns)
- Use the design system from STYLE.md for consistent UI elements

## Workflow

1. **Read the intent** — Which category above fits? Some requests blend categories (e.g., "interactive chart" = Chart + Interactive)
2. **Read STYLE.md** — Load `skills/visualizer/STYLE.md` for colors, typography, spacing, animation, and formatting
3. **Check for a reference template** — If a template exists in `skills/visualizer/templates/` that's close to what's needed, read it for structure and patterns. Adapt it freely.
4. **If no template fits, build freeform** — Many requests (diagrams, illustrations, simulations) won't match any template. Compose directly from HTML/CSS/JS/SVG using the design system.
5. **Write the file** — Save as `.viz` in the `visualizations/` folder

## Building Freeform Visualizations

When no template applies, build from scratch using these primitives:

### SVG Diagrams
```html
<svg viewBox="0 0 800 500" width="100%">
  <!-- Box node -->
  <rect x="50" y="50" width="160" height="60" rx="8" fill="var(--color-surface)" stroke="var(--color-border)"/>
  <text x="130" y="85" text-anchor="middle" font-size="14" fill="var(--color-text)">API Gateway</text>

  <!-- Arrow -->
  <line x1="210" y1="80" x2="300" y2="80" stroke="var(--color-text-muted)" stroke-width="1.5" marker-end="url(#arrow)"/>

  <!-- Arrow marker definition -->
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--color-text-muted)"/>
    </marker>
  </defs>
</svg>
```

### Animated Systems
```javascript
// Animation loop pattern
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

function animate() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // Update and draw state
  requestAnimationFrame(animate);
}
animate();
```

### Interactive Controls
```html
<input type="range" min="1" max="100" value="50" id="speed">
<script>
  document.getElementById('speed').addEventListener('input', (e) => {
    // Update visualization based on slider value
  });
</script>
```

## Data Formatting

For any visualization showing numbers, use these formatters:

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

## File Naming

Save all visualizations to `visualizations/{descriptive-name}.viz`. Examples:
- `visualizations/monthly-revenue-chart.viz`
- `visualizations/system-architecture-diagram.viz`
- `visualizations/solar-system-animation.viz`
- `visualizations/onboarding-flow-mockup.viz`

## Guidelines

- **Every visualization must fit its viewport without scrolling** — use `html, body { height: 100%; overflow: hidden }` and flex column body layout. See the "Viewport Fitting" section in STYLE.md.
- Visualizations are compact widgets, not web pages — no subtitles, tight padding (`0.75rem`), compact titles (`0.875rem`)
- The main content area must use `flex: 1; min-height: 0` to fill remaining space
- For multi-section layouts, prefer side-by-side over vertical stacking
- For unbounded data (tables, lists), only the data region scrolls — never the body
- Follow STYLE.md for all colors, typography, spacing, and animations
- Include hover states and tooltips where data points exist
- Use entry animations to make visualizations feel polished
- Format numbers properly — never show raw unformatted large numbers
- Use relative units for responsive sizing
- Add `aria-label` attributes to interactive and data elements
- Never use emojis — use inline SVGs for all icons (see STYLE.md)
- Keep labels short: max 5 words per box/node in diagrams
- For complex layouts, max 4 items per horizontal row before wrapping
