# Slide Generation — Progress

## What works

### HTML slide design
- Designed editorial-quality marketing slides using HTML/CSS (1920x1080px)
- Used `/frontend-design` skill to avoid generic AI-generated aesthetics
- Key design principles: serif + sans-serif pairing, warm palette, asymmetric layouts, bold typography as visual element, geometric color blocks
- Minimum readable font size ~18px for presentation context

### HTML → PDF
- Playwright renders HTML slides to pixel-perfect PDF
- `page.pdf()` with `printBackground: true`, zero margins, exact slide dimensions
- Also generates per-slide PNG screenshots for preview
- This works flawlessly — the PDF is the gold standard output

### HTML → PPTX (current approach)
- **All TypeScript** — single `generate-all.ts` pipeline using Playwright + PptxGenJS
- **DOM extraction**: Playwright walks the live DOM and extracts every element's computed styles (position, size, font-family, font-weight, font-style, color, letter-spacing, text-transform, text-align, rotation) via `getBoundingClientRect()` + `getComputedStyle()`
- Exports as structured JSON (`slide-data.json`) for debugging
- PptxGenJS builds native PPTX with real shapes (filled rectangles) and editable text boxes
- Font names, colors, and positions come directly from the browser — no guessing
- **Slide background colors** are extracted and applied
- **RGBA transparency** on shape fills is supported
- **Pseudo-element extraction** — `::before`/`::after` elements captured via `getComputedStyle(el, '::before')` and emitted as rects (e.g., black rectangle on slide 1, dark strip on slide 5, divider line on slide 2)
- **Text wrapping** — multi-line text detected by comparing range height to line height; uses parent element width for wrapping. Single-line text uses exact range width with wrap disabled
- **Text alignment** — `textAlign` extracted and mapped to PptxGenJS `align` (left/right/center/justify)
- **Rotation support** — CSS `transform: rotate()` extracted via matrix decomposition; mapped to PptxGenJS `rotate` prop with correct clockwise conversion. PPTX XML is correct but LibreOffice has limited rotated-text rendering
- **Text color transparency** — alpha channel on text colors mapped to PptxGenJS `transparency` (e.g., faint "ROI" background text on slide 4)
- **Visual feedback loop**: LibreOffice + Ghostscript render the PPTX back to PNGs for comparison against reference screenshots

## Current fidelity (per-slide)

| Slide | Rating | Notes |
|-------|--------|-------|
| 1 — Title | ★★★★☆ | Title, subtitle, geometric block + black rect correct. Vertical text correct in PPTX but LibreOffice misrenders rotated text boxes |
| 2 — Problem | ★★★★★ | 73%, heading, paragraph all wrap correctly. Vertical divider + accent line present |
| 3 — Approach | ★★★★★ | All 3 pillars render within columns with proper wrapping. Divider bars present |
| 4 — Results | ★★★★☆ | ROI faint, metrics positioned well, bottom bar correct. Minor text sizing differences |
| 5 — CTA | ★★★★★ | Left block with dark strip, CTA text, contact details all correct |

## What doesn't work / open issues

### Fonts
- **Font names pass through correctly** (e.g., "DM Sans", "DM Serif Display" appear in the PPTX XML)
- **Fonts are now embedded** — TTFs downloaded from Google Fonts GitHub, OOXML-obfuscated (first 32 bytes XOR'd with GUID), injected into `ppt/fonts/` as `.fntdata` with proper relationship entries and `<p:embeddedFontLst>` in `presentation.xml`
- Even when fonts ARE installed locally, variable font naming can cause mismatches (e.g., "DM Sans" variable font registers as "DM Sans 9pt" on macOS)

### Content fidelity (remaining)
- **Text atomization**: text boxes are per-text-node (one box per text run) — multi-line paragraphs become separate boxes instead of one text box with line breaks
- **Missing borders**: thin CSS border lines (pillar column dividers on slide 3) not captured as shapes
- Background gradients aren't supported (only solid fills)
- **LibreOffice rotation rendering**: rotated text boxes render as stacked characters in LibreOffice but are correct in the PPTX XML (works in PowerPoint/Keynote)

## Approaches tried and abandoned

| Approach | Result |
|----------|--------|
| **dom-to-pptx** (npm) | Halves all font sizes (1920px→10" scale), Type3 font name loss, pseudo-elements break layout |
| **PDF → PPTX via PyMuPDF + python-pptx** | Font names lost (Playwright PDF exports fonts as anonymous Type3), positioning requires scaling math |
| **python-pptx** (Python script) | Worked but added Python dependency; ported to PptxGenJS |
| **Aspose.Slides** (Python, commercial) | Renders PPTX to PNG for debugging but evaluation watermark, libgdiplus dependency |
| **Image-only PPTX** (screenshots embedded as slides) | Pixel-perfect but not editable — defeats the purpose |

## File structure

```
slide-demo/
├── slide.html          # Presentation source (5 editorial slides)
├── generate-all.ts     # Full pipeline: HTML → PDF + PNGs + JSON → PPTX → rendered PNGs
├── node_modules/       # playwright, pptxgenjs, jszip
└── output/
    ├── presentation.pdf
    ├── presentation.pptx
    ├── slide-data.json
    ├── slide-{1-5}.png       # Reference PNGs (from Playwright screenshots)
    └── pptx-render/
        └── slide-{1-5}.png   # PPTX rendered via LibreOffice for comparison
```

## Next steps

1. **Text grouping** — merge adjacent text nodes by parent element into multi-line text boxes
2. **Border extraction** — capture CSS borders and thin elements as lines/shapes
3. ~~**Font embedding**~~ ✅ — TTFs downloaded from Google Fonts GitHub, OOXML-obfuscated, embedded as `.fntdata`
4. **Gradient support** — extract CSS gradients and map to PptxGenJS gradient fills
5. **Better PPTX preview** — consider using PowerPoint's COM API or a cloud-based renderer instead of LibreOffice for more accurate comparison renders
