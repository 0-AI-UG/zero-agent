# Visualizer Style

Flat, clean, native feel. No gradients, shadows, blur, glow, or emoji. Light mode only. Font-weight max 500.

## Colors

Define in `:root`. Never hardcode hex in markup.

```css
:root {
  --bg: #ffffff; --bg-secondary: #f8f7f5;
  --text: #2c2c2a; --text-secondary: #5f5e5a; --text-tertiary: #888780;
  --border: rgba(0,0,0,0.12); --border-emphasis: rgba(0,0,0,0.25);
}
```

**Ramps** (use 50 for fills, 400 for accents, 600 for strokes/text, 900 for bold labels):

| Ramp | 50 | 400 | 600 | 900 |
|------|-----|------|------|------|
| Purple | #EEEDFE | #7F77DD | #534AB7 | #26215C |
| Teal | #E1F5EE | #1D9E75 | #0F6E56 | #04342C |
| Coral | #FAECE7 | #D85A30 | #993C1D | #4A1B0C |
| Blue | #E6F1FB | #378ADD | #185FA5 | #042C53 |
| Green | #EAF3DE | #639922 | #3B6D11 | #173404 |
| Amber | #FAEEDA | #EF9F27 | #854F0B | #412402 |
| Red | #FCEBEB | #E24B4A | #A32D2D | #501313 |

**Series**: `#534AB7`, `#0F6E56`, `#D85A30`, `#185FA5`, `#639922`, `#854F0B` (max 6)

## Base Styles

Every file must include:

```css
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: var(--text); background: var(--bg); }
```

Content determines height — never set `height: 100%` or `overflow: hidden` on body. No body padding; vizzes bleed edge-to-edge. SVG: use `viewBox` + `width="100%"`.

## Typography

System font stack. Weights: 400 and 500 only. Sizes: titles 14px/500, body 13px/400, small 11px/400. Min 11px.

## Nodes & Edges

- **Nodes**: `fill: var(--bg)`, `stroke: var(--border)`, `rx="8"`. Hover: `stroke: var(--border-emphasis)`. Label: 13px centered.
- **Edges**: `stroke: var(--text-tertiary)`, `1.5px`. Hover highlights connected edges to ramp-400.
- **Arrow marker**: `<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="var(--text-tertiary)"/></marker>`

## Animations

Entry animations play once. Easing: `cubic-bezier(0.4, 0, 0.2, 1)`. Duration: 400ms entries, 150ms hover. Stagger: 50ms per item.

```css
@keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
```

## File Structure

`<style>` → content HTML → `<script>`. Keep style block compact.
