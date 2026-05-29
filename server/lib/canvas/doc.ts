/**
 * Canvas document model + pure op-application, shared by the WebSocket
 * collaboration handler (`server/lib/http/ws.ts`) and the agent-facing
 * CLI handler (`server/cli-handlers/canvas.ts`).
 *
 * A canvas is project-scoped: exactly one document per project. The
 * canonical state is a flat list of shapes persisted as JSON in the
 * `canvas_documents` table. Live editing happens by applying small ops
 * and rebroadcasting them; the full doc is only fetched on mount.
 *
 * Keep this module free of DB / IO so it stays trivially testable and
 * usable from either entry point.
 */

export type ShapeType = "note" | "rect" | "ellipse" | "text" | "arrow";

export interface Shape {
  id: string;
  type: ShapeType;
  /** Top-left for box shapes; start point for arrows. */
  x: number;
  y: number;
  /** Box size. Ignored for arrows. */
  w?: number;
  h?: number;
  /** Arrow end point. Ignored for box shapes. */
  x2?: number;
  y2?: number;
  text?: string;
  /** Palette key (yellow/blue/green/pink/gray/...). The UI maps it to CSS. */
  color?: string;
}

export interface CanvasDoc {
  shapes: Shape[];
  updatedAt: number;
}

export type CanvasOp =
  | { kind: "add"; shape: Shape }
  | { kind: "update"; id: string; props: Partial<Omit<Shape, "id" | "type">> }
  | { kind: "delete"; id: string }
  | { kind: "clear" };

export function emptyDoc(): CanvasDoc {
  return { shapes: [], updatedAt: 0 };
}

/** Parse a stored JSON string into a doc, tolerating null / corruption. */
export function parseDoc(json: string | null | undefined): CanvasDoc {
  if (!json) return emptyDoc();
  try {
    const parsed = JSON.parse(json) as Partial<CanvasDoc>;
    if (!parsed || !Array.isArray(parsed.shapes)) return emptyDoc();
    return { shapes: parsed.shapes as Shape[], updatedAt: parsed.updatedAt ?? 0 };
  } catch {
    return emptyDoc();
  }
}

const SHAPE_TYPES: ShapeType[] = ["note", "rect", "ellipse", "text", "arrow"];
const MAX_SHAPES = 2000;
const MAX_TEXT = 4000;

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** Coerce arbitrary input into a well-formed shape (used for `add`). */
export function normalizeShape(input: Partial<Shape> & { id: string; type: string }): Shape {
  const type = (SHAPE_TYPES as string[]).includes(input.type)
    ? (input.type as ShapeType)
    : "note";
  const shape: Shape = {
    id: input.id,
    type,
    x: num(input.x),
    y: num(input.y),
  };
  if (type === "arrow") {
    shape.x2 = num(input.x2, shape.x + 120);
    shape.y2 = num(input.y2, shape.y);
  } else {
    shape.w = num(input.w, type === "text" ? 160 : 120);
    shape.h = num(input.h, type === "text" ? 40 : 80);
  }
  if (typeof input.text === "string") shape.text = input.text.slice(0, MAX_TEXT);
  if (typeof input.color === "string") shape.color = input.color.slice(0, 32);
  return shape;
}

/**
 * Axis-aligned bounding box of a shape. Boxes use x/y/w/h directly; an
 * arrow's box spans its two endpoints. Mirrors the UI's `bounds()` so the
 * server anchors arrows exactly where the client would draw them.
 */
export function shapeBounds(s: Shape): { x: number; y: number; w: number; h: number } {
  if (s.type === "arrow") {
    const x2 = s.x2 ?? s.x;
    const y2 = s.y2 ?? s.y;
    return { x: Math.min(s.x, x2), y: Math.min(s.y, y2), w: Math.abs(x2 - s.x), h: Math.abs(y2 - s.y) };
  }
  return { x: s.x, y: s.y, w: s.w ?? 120, h: s.h ?? 80 };
}

/** Point on box `b`'s border along the ray from its center toward (tx,ty). */
function edgePoint(b: { x: number; y: number; w: number; h: number }, tx: number, ty: number) {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const dx = tx - cx;
  const dy = ty - cy;
  const hw = b.w / 2;
  const hh = b.h / 2;
  if ((dx === 0 && dy === 0) || hw === 0 || hh === 0) return { x: cx, y: cy };
  const scale = 1 / Math.max(Math.abs(dx) / hw, Math.abs(dy) / hh);
  return { x: Math.round(cx + dx * scale), y: Math.round(cy + dy * scale) };
}

/**
 * Edge-to-edge connector coordinates between two shapes: the line joining
 * their centers, clipped to each shape's border so an arrow visibly touches
 * both boxes instead of burying its tips inside them. Lets callers connect
 * shapes by reference and let the server do the geometry.
 */
export function anchorBetween(a: Shape, b: Shape): { x: number; y: number; x2: number; y2: number } {
  const ba = shapeBounds(a);
  const bb = shapeBounds(b);
  const ca = { x: ba.x + ba.w / 2, y: ba.y + ba.h / 2 };
  const cb = { x: bb.x + bb.w / 2, y: bb.y + bb.h / 2 };
  const start = edgePoint(ba, cb.x, cb.y);
  const end = edgePoint(bb, ca.x, ca.y);
  return { x: start.x, y: start.y, x2: end.x, y2: end.y };
}

/**
 * Apply an op to a doc, returning a NEW doc (the input is not mutated).
 * Unknown / no-op edits return the doc unchanged so callers can skip a
 * pointless broadcast by reference-comparing the result.
 */
export function applyCanvasOp(doc: CanvasDoc, op: CanvasOp): CanvasDoc {
  switch (op.kind) {
    case "add": {
      if (doc.shapes.length >= MAX_SHAPES) return doc;
      const shape = normalizeShape(op.shape);
      // Replace if the id already exists (idempotent add).
      const idx = doc.shapes.findIndex((s) => s.id === shape.id);
      const shapes =
        idx === -1
          ? [...doc.shapes, shape]
          : doc.shapes.map((s, i) => (i === idx ? shape : s));
      return { shapes, updatedAt: doc.updatedAt };
    }
    case "update": {
      const idx = doc.shapes.findIndex((s) => s.id === op.id);
      if (idx === -1) return doc;
      const prev = doc.shapes[idx]!;
      const next: Shape = { ...prev };
      const p = op.props;
      if (p.x !== undefined) next.x = num(p.x, prev.x);
      if (p.y !== undefined) next.y = num(p.y, prev.y);
      if (p.w !== undefined) next.w = num(p.w, prev.w);
      if (p.h !== undefined) next.h = num(p.h, prev.h);
      if (p.x2 !== undefined) next.x2 = num(p.x2, prev.x2);
      if (p.y2 !== undefined) next.y2 = num(p.y2, prev.y2);
      if (p.text !== undefined) next.text = String(p.text).slice(0, MAX_TEXT);
      if (p.color !== undefined) next.color = String(p.color).slice(0, 32);
      const shapes = doc.shapes.map((s, i) => (i === idx ? next : s));
      return { shapes, updatedAt: doc.updatedAt };
    }
    case "delete": {
      const shapes = doc.shapes.filter((s) => s.id !== op.id);
      if (shapes.length === doc.shapes.length) return doc;
      return { shapes, updatedAt: doc.updatedAt };
    }
    case "clear": {
      if (doc.shapes.length === 0) return doc;
      return { shapes: [], updatedAt: doc.updatedAt };
    }
    default:
      return doc;
  }
}
