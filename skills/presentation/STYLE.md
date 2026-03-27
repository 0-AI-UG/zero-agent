# Presentation Design System

Follow these guidelines for all slide decks to ensure a consistent, professional look.

## Color Palette

```css
:root {
  --bg:        #0A0A0A;
  --surface:   #141414;
  --surface-2: #1E1E1E;
  --surface-3: #262626;
  --text:      #F5F5F5;
  --text-dim:  #A3A3A3;
  --text-mute: #525252;
  --accent:    #3B82F6;
  --accent-2:  #8B5CF6;
  --border:    #262626;
  --success:   #22C55E;
  --danger:    #EF4444;
}
```

Dark theme only. All slides use a dark background for maximum contrast and a modern feel.

### Data Series Colors (use in order)

```
#3B82F6, #8B5CF6, #22C55E, #F59E0B
```

Reserve `--success` and `--danger` for semantic indicators (status, up/down changes) — not chart series.

## Typography

Use **Inter** via Google Fonts — the only allowed font stack.

```css
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');
font-family: 'Inter', sans-serif;
```

For code snippets, add **Fira Code**:
```css
@import url('https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;500&display=swap');
```

### Type Scale (for 1920x1080 canvas)

| Element | Size | Weight | Color |
|---------|------|--------|-------|
| Slide title (hero) | 80-120px | 700 | var(--text) |
| Slide heading | 48-64px | 600 | var(--text) |
| Subheading | 32-40px | 500 | var(--text-dim) |
| Body text | 28-32px | 400 | var(--text-dim) |
| Caption / label | 20-24px | 400 | var(--text-mute) |
| KPI number | 72-96px | 700 | var(--accent) |
| KPI label | 20-24px | 500 | var(--text-dim) |
| Code | 22-26px | 400 | var(--text) (Fira Code) |

## Layout Patterns

### Title Slide
- Large title centered or left-aligned in the upper 60% of the slide
- Subtitle below in `--text-dim`
- Optional brand/logo area top-left
- Optional decorative element (gradient shape, accent line) for visual interest

### Content Slide
- Heading in top 20% of the slide
- Content area below with generous padding (100-140px from edges)
- Bullet points: use `--accent` colored markers, 40px line spacing

### Two-Column
- 50/50 or 60/40 split using flexbox
- 60-80px gap between columns
- Each column padded 100px from outer edges

### Section Divider
- Large centered text (80-120px)
- Minimal other content — just the section name and optional subtitle
- Accent line or gradient background for visual separation

### Data Slide
- Title at top
- Charts built with inline SVG (bars, lines, donut)
- Metrics as large KPI numbers in a grid layout
- Labels below each metric in `--text-mute`

## Spacing

- Slide padding: `100px` on all sides (safe area)
- Element gap: `40px` between major blocks
- Text line-height: `1.4` for body, `1.1` for headings
- Between bullet items: `32px`

## Decorative Elements

Use sparingly for visual interest:

- **Accent lines**: `2-3px` solid lines in `var(--accent)`, partial width
- **Gradient backgrounds**: subtle `linear-gradient` on the slide background (e.g., `linear-gradient(135deg, #0A0A0A 0%, #141428 100%)`)
- **Colored shapes**: `border-radius` rectangles or circles with low opacity accent colors
- **Border containers**: `1px solid var(--border)` with `border-radius: 16px` for card-like groupings

Avoid: drop shadows, blur effects, complex patterns (these don't survive PPTX conversion).

## Icons

Never use emojis or HTML entities. Use inline SVG for all icons:

```html
<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <!-- icon path -->
</svg>
```

Scale with explicit `width`/`height` in px (not em, since slides are fixed-size). Use `currentColor` for stroke/fill.
