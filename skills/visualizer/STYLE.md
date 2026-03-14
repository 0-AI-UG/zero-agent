# Visualizer Design System

Follow these guidelines for all HTML visualizations to ensure a consistent, polished look.

## Color Palette

```css
:root {
  --color-bg: #ffffff;
  --color-surface: #ffffff;
  --color-surface-muted: #f5f5f5;
  --color-border: #e5e5e5;
  --color-text: #1b1b1b;
  --color-text-muted: #737373;
  --color-primary: #005bd9;
  --color-primary-light: #3b82f6;
  --color-success: #16a34a;
  --color-danger: #dc2626;
}
```

Light mode only — no `prefers-color-scheme` media query.

### Chart Colors (use in order for data series)

Use a monochromatic scale based on the primary color. This keeps visualizations clean and professional. Only use 4 colors max per chart.

```
#005bd9, #4d8ce8, #94b8f0, #c7d9f7
```

Reserve `--color-success` and `--color-danger` strictly for semantic indicators (status badges, up/down changes) — never as chart series colors.

## Typography

Use the system font stack — no external fonts.

```css
font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
```

| Element | Size | Weight |
|---------|------|--------|
| Page title | 1.5rem | 700 |
| Section heading | 1.125rem | 600 |
| Body text | 0.875rem | 400 |
| Small/caption | 0.75rem | 400 |
| KPI number | 2rem | 700 |
| KPI label | 0.75rem | 500 |

## Layout

- Use flexbox for all layouts
- Card pattern: `background: var(--color-surface); border: 1px solid var(--color-border); border-radius: 0.625rem; padding: 1.25rem; box-shadow: 0 1px 3px rgba(0,0,0,0.04);`
- Spacing scale: `0.25rem, 0.5rem, 0.75rem, 1rem, 1.25rem, 1.5rem, 2rem`
- Page padding: `1.5rem`
- Card gap: `1rem`

## Interactive Patterns

- **Hover on data points**: Show tooltip with value, use `transition: all 0.15s ease`
- **Hover on rows/cards**: Subtle background shift `background: var(--color-surface-muted)` with `0.15s` transition
- **Click to filter**: Toggle active state with `var(--color-primary)` highlight
- **Tooltips**: Positioned absolutely, `background: var(--color-text); color: var(--color-bg); padding: 0.375rem 0.625rem; border-radius: 0.25rem; font-size: 0.75rem;`

## Responsive

- Use `%` and `rem` for widths — no fixed pixel widths on containers
- Charts: use `100%` width, aspect ratio via padding or viewBox
- Tables: `overflow-x: auto` wrapper for horizontal scroll on narrow viewports
- Dashboard grid: `display: flex; flex-wrap: wrap; gap: 1rem;` with cards at `min-width: 200px; flex: 1;`

## Icons

Never use emojis or HTML emoji entities. Use inline SVGs for all icons. SVGs should:

- Use `currentColor` for fill/stroke so they inherit text color
- Be sized with `width` and `height` in `em` units (e.g., `1em`, `1.25em`) so they scale with text
- Have `viewBox` set and no hardcoded colors unless intentional
- Include `aria-hidden="true"` when decorative (paired with text label)

Example icon pattern:
```html
<svg width="1.25em" height="1.25em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline>
</svg>
```

Common icon set to use in templates:
- **Trending up**: `<polyline points="22 12 18 12 15 21 9 3 6 12 2 12">`
- **Bar chart**: `<line x1="18" y1="20" x2="18" y2="10"></line><line x1="12" y1="20" x2="12" y2="4"></line><line x1="6" y1="20" x2="6" y2="14"></line>`
- **Clock**: `<circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14">`
- **Alert**: `<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17">`
- **Check circle**: `<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01">`
- **Zap/bolt**: `<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2">`

## Accessibility

- All interactive elements need `role` and `aria-label`
- Color contrast: maintain 4.5:1 minimum ratio
- Chart data should also be available as a visually-hidden table
- Focus styles: `outline: 2px solid var(--color-primary); outline-offset: 2px;`
