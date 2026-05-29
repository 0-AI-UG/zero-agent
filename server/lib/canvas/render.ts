/**
 * Server-side canvas rendering — turns the shape list into a PNG so the
 * agent can *see* what it drew, not just trust the JSON it sent.
 *
 * This is a deliberately plain (non-rough.js) render: the hand-drawn
 * sketchiness is irrelevant for verification and a clean render is actually
 * more legible to a vision model. Geometry, palette, default sizes and arrow
 * anchoring all mirror the React canvas (`web/src/pages/CanvasPage.tsx` +
 * `doc.ts`) so the image faithfully reflects the collaborative board.
 *
 * Output goes through `sharp` (already a project dependency) to rasterize the
 * SVG to PNG. No browser, no auth, no WebSocket hydration.
 */
import sharp from "sharp";
import { shapeBounds, type Shape } from "./doc.ts";

// Ported verbatim from the web palette so colors match the live board.
const PALETTE: Record<string, { fill: string; stroke: string; text: string }> = {
  yellow: { fill: "#fdf6d8", stroke: "#d4b94e", text: "#7a6320" },
  blue: { fill: "#e3eefb", stroke: "#8fb3e8", text: "#3a5680" },
  green: { fill: "#e0f3e8", stroke: "#84cfa0", text: "#356349" },
  pink: { fill: "#fce4ef", stroke: "#e79bbd", text: "#803a5e" },
  purple: { fill: "#ece6fb", stroke: "#ab9ce8", text: "#4f4385" },
  orange: { fill: "#fcebd9", stroke: "#ecb084", text: "#80502b" },
  gray: { fill: "#eff2f6", stroke: "#b3bdc9", text: "#4a5563" },
};

function colorOf(shape: Shape) {
  const key = shape.color && shape.color in PALETTE ? shape.color : "yellow";
  return PALETTE[key]!;
}

const FONT_SIZE = 17;
const LINE_HEIGHT = 21; // ~ fontSize * 1.25, matching the web line-height
const PADDING = 40; // margin around the shapes' bounding box
const MAX_DIM = 2000; // cap on the longest rasterized side (px)
const FONT_STACK =
  "'Comic Sans MS', 'Segoe Print', 'Bradley Hand', 'Patrick Hand', sans-serif";

// Sharp's bundled Pango calls abort() (SIGTRAP → process exit 133) when it has
// to fall back to a color-emoji font it can't load — e.g. any char carrying the
// emoji variation selector. That kills the whole server, and the try/catch in
// handleCanvasView can't intercept a native abort. So strip emoji pictographs
// and the selectors/joiners/modifiers that route text to that font before it
// reaches the SVG. This is a verification render; the vision model doesn't need
// the emoji, and never crashing matters far more than rendering them.
const EMOJI_RE =
  /[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\u200D\uFE0E\uFE0F]/gu;

function escapeXml(s: string): string {
  return s
    .replace(EMOJI_RE, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Greedy word-wrap to fit `maxWidthPx`, honoring explicit newlines. Width is
 * estimated from an average glyph advance (~0.52em for this font stack) — good
 * enough to keep labels inside their boxes without a real text-measure pass.
 */
function wrapText(text: string, maxWidthPx: number): string[] {
  const maxChars = Math.max(1, Math.floor(maxWidthPx / (FONT_SIZE * 0.52)));
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.length === 0) {
      lines.push("");
      continue;
    }
    let current = "";
    for (const word of paragraph.split(/\s+/)) {
      const candidate = current ? `${current} ${word}` : word;
      if (candidate.length <= maxChars) {
        current = candidate;
      } else {
        if (current) lines.push(current);
        // A single word longer than the line: hard-split it.
        if (word.length > maxChars) {
          let rest = word;
          while (rest.length > maxChars) {
            lines.push(rest.slice(0, maxChars));
            rest = rest.slice(maxChars);
          }
          current = rest;
        } else {
          current = word;
        }
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

/** Center a wrapped block vertically inside a box and emit one <text>. */
function centeredLabel(text: string, cx: number, cy: number, maxWidthPx: number, fill: string): string {
  const lines = wrapText(text, maxWidthPx);
  if (lines.length === 0) return "";
  const startY = cy - ((lines.length - 1) * LINE_HEIGHT) / 2;
  const tspans = lines
    .map((line, i) => `<tspan x="${cx}" y="${startY + i * LINE_HEIGHT}">${escapeXml(line)}</tspan>`)
    .join("");
  return `<text text-anchor="middle" dominant-baseline="central" font-family="${FONT_STACK}" font-size="${FONT_SIZE}" fill="${fill}">${tspans}</text>`;
}

function renderBox(shape: Shape): string {
  const c = colorOf(shape);
  const w = shape.w ?? 120;
  const h = shape.h ?? 80;
  if (w <= 0 || h <= 0) return "";
  const cx = shape.x + w / 2;
  const cy = shape.y + h / 2;
  const body =
    shape.type === "ellipse"
      ? `<ellipse cx="${cx}" cy="${cy}" rx="${w / 2}" ry="${h / 2}" fill="${c.fill}" stroke="${c.stroke}" stroke-width="2" />`
      : `<rect x="${shape.x}" y="${shape.y}" width="${w}" height="${h}" rx="12" ry="12" fill="${c.fill}" stroke="${c.stroke}" stroke-width="2" />`;
  const label = shape.text ? centeredLabel(shape.text, cx, cy, w - 20, c.text) : "";
  return body + label;
}

/** Free-floating text shape: label only, top-aligned and centered (no box). */
function renderText(shape: Shape): string {
  const c = colorOf(shape);
  const w = shape.w ?? 200;
  const cx = shape.x + w / 2;
  const lines = wrapText(shape.text ?? "", w - 20);
  const startY = shape.y + 10 + LINE_HEIGHT / 2;
  const tspans = lines
    .map((line, i) => `<tspan x="${cx}" y="${startY + i * LINE_HEIGHT}">${escapeXml(line)}</tspan>`)
    .join("");
  return `<text text-anchor="middle" dominant-baseline="central" font-family="${FONT_STACK}" font-size="${FONT_SIZE}" fill="${c.text}">${tspans}</text>`;
}

function renderArrow(shape: Shape): string {
  const c = colorOf(shape);
  const x1 = shape.x;
  const y1 = shape.y;
  const x2 = shape.x2 ?? shape.x + 100;
  const y2 = shape.y2 ?? shape.y;
  // Arrowhead geometry mirrors the web (open V, spread π/7, length ≤ 20).
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const len = Math.hypot(x2 - x1, y2 - y1);
  const head = Math.min(20, len * 0.4);
  const spread = Math.PI / 7;
  const hx1 = x2 - head * Math.cos(ang - spread);
  const hy1 = y2 - head * Math.sin(ang - spread);
  const hx2 = x2 - head * Math.cos(ang + spread);
  const hy2 = y2 - head * Math.sin(ang + spread);
  const line = `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${c.stroke}" stroke-width="2" stroke-linecap="round" />`;
  const arrowHead = `<polyline points="${hx1},${hy1} ${x2},${y2} ${hx2},${hy2}" fill="none" stroke="${c.stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />`;
  let label = "";
  if (shape.text) {
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    const textW = shape.text.length * FONT_SIZE * 0.52;
    label =
      `<rect x="${mx - textW / 2 - 4}" y="${my - LINE_HEIGHT / 2}" width="${textW + 8}" height="${LINE_HEIGHT}" rx="3" fill="#ffffff" opacity="0.85" />` +
      `<text x="${mx}" y="${my}" text-anchor="middle" dominant-baseline="central" font-family="${FONT_STACK}" font-size="${FONT_SIZE}" fill="${c.stroke}">${escapeXml(shape.text)}</text>`;
  }
  return line + arrowHead + label;
}

function renderShape(shape: Shape): string {
  if (shape.type === "arrow") return renderArrow(shape);
  if (shape.type === "text") return renderText(shape);
  return renderBox(shape);
}

/**
 * Build the full SVG document for a shape list: auto-fit the bounding box of
 * everything on the board, pad it, and cap the rasterized size at MAX_DIM on
 * the longest side. Returns the SVG plus the pixel dimensions sharp will use.
 */
export function renderCanvasSvg(shapes: Shape[]): { svg: string; width: number; height: number } {
  if (shapes.length === 0) {
    const w = 480;
    const h = 200;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#ffffff" /><text x="${w / 2}" y="${h / 2}" text-anchor="middle" dominant-baseline="central" font-family="${FONT_STACK}" font-size="18" fill="#9aa3ad">Canvas is empty</text></svg>`;
    return { svg, width: w, height: h };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of shapes) {
    const b = shapeBounds(s);
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  const originX = minX - PADDING;
  const originY = minY - PADDING;
  const vbW = maxX - minX + PADDING * 2;
  const vbH = maxY - minY + PADDING * 2;

  const longest = Math.max(vbW, vbH);
  const scale = longest > MAX_DIM ? MAX_DIM / longest : 1;
  const pxW = Math.max(1, Math.round(vbW * scale));
  const pxH = Math.max(1, Math.round(vbH * scale));

  // Arrows last so connectors sit on top of the boxes they join.
  const ordered = [...shapes].sort((a, b) => (a.type === "arrow" ? 1 : 0) - (b.type === "arrow" ? 1 : 0));
  const body = ordered.map(renderShape).join("");

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${pxW}" height="${pxH}" viewBox="${originX} ${originY} ${vbW} ${vbH}">` +
    `<rect x="${originX}" y="${originY}" width="${vbW}" height="${vbH}" fill="#ffffff" />` +
    body +
    `</svg>`;
  return { svg, width: pxW, height: pxH };
}

/** Render the shape list to a PNG buffer. */
export async function renderCanvasPng(shapes: Shape[]): Promise<Buffer> {
  const { svg } = renderCanvasSvg(shapes);
  return sharp(Buffer.from(svg)).png().toBuffer();
}
