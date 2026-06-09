import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { useParams } from "react-router";
import { nanoid } from "nanoid";
import rough from "roughjs";
import {
  MousePointer2Icon,
  BoxSelectIcon,
  SquareIcon,
  CircleIcon,
  TypeIcon,
  MoveUpRightIcon,
  Trash2Icon,
  EraserIcon,
  DownloadIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useAuthStore } from "@/stores/auth";
import { subscribe, sendCanvasOp, sendCanvasCursor } from "@/lib/ws";
import { useCanvas, type CanvasShape, type CanvasShapeType, type CanvasOp } from "@/api/canvas";

// ── Palette ──────────────────────────────────────────────────────────

type ColorKey = "yellow" | "blue" | "green" | "pink" | "purple" | "orange" | "gray";

const PALETTE: Record<ColorKey, { fill: string; stroke: string; text: string }> = {
  yellow: { fill: "#fdf6d8", stroke: "#d4b94e", text: "#7a6320" },
  blue: { fill: "#e3eefb", stroke: "#8fb3e8", text: "#3a5680" },
  green: { fill: "#e0f3e8", stroke: "#84cfa0", text: "#356349" },
  pink: { fill: "#fce4ef", stroke: "#e79bbd", text: "#803a5e" },
  purple: { fill: "#ece6fb", stroke: "#ab9ce8", text: "#4f4385" },
  orange: { fill: "#fcebd9", stroke: "#ecb084", text: "#80502b" },
  gray: { fill: "#eff2f6", stroke: "#b3bdc9", text: "#4a5563" },
};
const COLOR_KEYS = Object.keys(PALETTE) as ColorKey[];

function colorOf(shape: CanvasShape) {
  return PALETTE[(shape.color as ColorKey) in PALETTE ? (shape.color as ColorKey) : "yellow"];
}

// Deterministic cursor color from a session origin string.
function originColor(origin: string): string {
  let hash = 0;
  for (let i = 0; i < origin.length; i++) hash = origin.charCodeAt(i) + ((hash << 5) - hash);
  return `oklch(0.6 0.18 ${Math.abs(hash) % 360})`;
}

type Tool = "select" | "marquee" | CanvasShapeType;

const TOOLS: { tool: Tool; icon: typeof SquareIcon; label: string }[] = [
  { tool: "select", icon: MousePointer2Icon, label: "Select / pan" },
  { tool: "marquee", icon: BoxSelectIcon, label: "Rectangle select" },
  { tool: "rect", icon: SquareIcon, label: "Rectangle" },
  { tool: "ellipse", icon: CircleIcon, label: "Ellipse" },
  { tool: "text", icon: TypeIcon, label: "Text" },
  { tool: "arrow", icon: MoveUpRightIcon, label: "Arrow" },
];

/** Tools that select/move existing shapes (vs. tools that create new ones). */
function isSelectTool(t: Tool): boolean {
  return t === "select" || t === "marquee";
}

/** Axis-aligned overlap test, used for marquee hit-testing. */
function boxesIntersect(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

const MIN = 0.2;
const MAX = 4;

interface View {
  tx: number;
  ty: number;
  scale: number;
}

interface Cursor {
  x: number;
  y: number;
  name: string;
  color: string;
  ts: number;
  /** Set when this contributor just applied an op (drives the pulse). */
  workingTs?: number;
}

// Handwritten font for the Excalidraw-style sketchy look.
const HAND_FONT = "'Patrick Hand', 'Comic Sans MS', cursive";

// Single shared rough.js generator — produces the hand-drawn SVG path data.
const roughGen = rough.generator();

// Stable integer seed from a shape id so the sketch doesn't re-randomize on
// every render (only when the geometry actually changes).
function seedOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// Rounded-rect SVG path — rough.js roughens this into a sketchy outline.
function roundRectPath(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  return (
    `M${x + rr},${y} L${x + w - rr},${y} Q${x + w},${y} ${x + w},${y + rr} ` +
    `L${x + w},${y + h - rr} Q${x + w},${y + h} ${x + w - rr},${y + h} ` +
    `L${x + rr},${y + h} Q${x},${y + h} ${x},${y + h - rr} ` +
    `L${x},${y + rr} Q${x},${y} ${x + rr},${y} Z`
  );
}

// Anchor point (top-left) + bounding box of a shape, used for marquee hit-testing.
function shapeBox(s: CanvasShape) {
  if (s.type === "arrow") {
    const x2 = s.x2 ?? s.x;
    const y2 = s.y2 ?? s.y;
    return { x: Math.min(s.x, x2), y: Math.min(s.y, y2), w: Math.abs(x2 - s.x), h: Math.abs(y2 - s.y) };
  }
  return { x: s.x, y: s.y, w: s.w ?? 120, h: s.h ?? 80 };
}

function defaultShape(type: CanvasShapeType, x: number, y: number, color: ColorKey): CanvasShape {
  const id = nanoid();
  if (type === "arrow") return { id, type, x, y, x2: x + 120, y2: y, color };
  if (type === "text") return { id, type, x, y, w: 200, h: 40, text: "Text", color };
  if (type === "ellipse") return { id, type, x, y, w: 130, h: 130, text: "", color };
  return { id, type, x, y, w: 170, h: 110, text: "", color }; // rect
}

// Shallow field-equality for two shapes — used to decide when a server
// snapshot has "caught up" to a local optimistic override so it can be dropped.
function shapeEq(a: CanvasShape | undefined, b: CanvasShape | undefined): boolean {
  if (!a || !b) return false;
  return (
    a.type === b.type &&
    a.x === b.x &&
    a.y === b.y &&
    a.w === b.w &&
    a.h === b.h &&
    a.x2 === b.x2 &&
    a.y2 === b.y2 &&
    a.text === b.text &&
    a.color === b.color
  );
}

// Safety backstop: if a committed override isn't confirmed by a snapshot within
// this window (e.g. another user edited the same shape concurrently, so the
// server value never matches ours), drop it anyway so we can't wedge.
const OVERRIDE_TTL = 800;

// ── Component ────────────────────────────────────────────────────────

export function CanvasPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const pid = projectId!;
  const username = useAuthStore((s) => s.user?.username) ?? "Someone";

  const { data: doc } = useCanvas(pid);

  const origin = useRef<string>(nanoid());
  // ── Sync model: authoritative server state + a thin local override layer ──
  // The server is the single source of truth and pushes the *entire* board as a
  // `canvas.state` snapshot on every change (and on join). We render that
  // snapshot directly, so a missed message, a reconnect, or a race can never
  // leave us diverged — the next snapshot is the truth and overwrites us.
  //
  // `overrides` is the only local state: shapes the user is *actively*
  // manipulating (so their own drag/type stays instant instead of waiting a
  // round-trip) or has just committed but the snapshot hasn't confirmed yet.
  // `shape: null` is an optimistic-delete tombstone. `committedAt === null`
  // means "still being manipulated" (never auto-cleared); once committed, the
  // override is dropped as soon as a snapshot confirms it (or after a timeout).
  const [serverShapes, setServerShapes] = useState<Record<string, CanvasShape>>({});
  const serverShapesRef = useRef(serverShapes);
  serverShapesRef.current = serverShapes;
  const overridesRef = useRef<Record<string, { shape: CanvasShape | null; committedAt: number | null }>>({});
  const [renderTick, setRenderTick] = useState(0);
  const bump = useCallback(() => setRenderTick((t) => (t + 1) & 0xffff), []);

  const [tool, setTool] = useState<Tool>("select");
  const [color, setColor] = useState<ColorKey>("yellow");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  // Live marquee (rectangle-select) box in world coordinates while dragging.
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [view, setView] = useState<View>({ tx: 0, ty: 0, scale: 1 });
  const [cursors, setCursors] = useState<Record<string, Cursor>>({});

  // Rendered board = the server snapshot with local overrides laid on top.
  const shapes = useMemo(() => {
    const merged: Record<string, CanvasShape> = { ...serverShapes };
    for (const [id, o] of Object.entries(overridesRef.current)) {
      if (o.shape === null) delete merged[id];
      else merged[id] = o.shape;
    }
    return merged;
    // renderTick bumps whenever overridesRef mutates.
  }, [serverShapes, renderTick]);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const shapesRef = useRef(shapes);
  shapesRef.current = shapes;
  const viewRef = useRef(view);
  viewRef.current = view;
  const dragRef = useRef<any>(null);
  const lastCursorRef = useRef(0);
  const lastMoveRef = useRef(0);
  const lastTextRef = useRef(0);
  const hydratedRef = useRef(false);
  // Cursor position smoothing. `cursors` holds the *target* positions; a rAF
  // loop eases the *rendered* positions toward them so every contributor's
  // cursor (especially the agent's shape-to-shape hops) always glides rather
  // than teleports — independent of flaky CSS transform transitions on SVG.
  const cursorsRef = useRef(cursors);
  cursorsRef.current = cursors;
  const cursorPosRef = useRef<Record<string, { x: number; y: number }>>({});
  const [, setCursorFrame] = useState(0);

  // Seed from the REST snapshot for instant first paint; the WS `canvas.state`
  // stream (which also fires on join) takes over as the authority immediately.
  useEffect(() => {
    if (hydratedRef.current || !doc) return;
    const map: Record<string, CanvasShape> = {};
    for (const s of doc.shapes) map[s.id] = s;
    setServerShapes(map);
    hydratedRef.current = true;
  }, [doc]);

  // Apply an op to the local override layer. `committed=false` marks it as an
  // in-progress gesture (rendered locally, never auto-cleared); `committed=true`
  // means we've sent it to the server and it can be dropped once a snapshot
  // confirms it. Reads the current rendered shape as the base for updates.
  const localOp = useCallback(
    (op: CanvasOp, committed: boolean) => {
      const ov = overridesRef.current;
      const at = committed ? Date.now() : null;
      if (op.kind === "add") {
        ov[op.shape.id] = { shape: op.shape, committedAt: at };
      } else if (op.kind === "update") {
        const cur = ov[op.id]?.shape ?? serverShapesRef.current[op.id];
        if (cur) ov[op.id] = { shape: { ...cur, ...op.props }, committedAt: at };
      } else if (op.kind === "delete") {
        ov[op.id] = { shape: null, committedAt: Date.now() };
      }
      bump();
    },
    [bump],
  );

  // Mark an in-progress override as committed (sent to the server) so the next
  // confirming snapshot can retire it.
  const markCommitted = useCallback((id: string) => {
    const o = overridesRef.current[id];
    if (o) o.committedAt = Date.now();
  }, []);

  // Apply locally (optimistically) + send to the server in one step. Used for
  // instant, non-gesture mutations (color, delete, clear).
  const commit = useCallback(
    (op: CanvasOp) => {
      if (op.kind === "clear") {
        // Optimistically tombstone everything currently shown; snapshots
        // confirm the empty board. Tombstones survive a stale pre-clear
        // snapshot and retire once the post-clear (empty) snapshot lands.
        const ov: typeof overridesRef.current = {};
        const now = Date.now();
        for (const id of Object.keys(shapesRef.current)) ov[id] = { shape: null, committedAt: now };
        overridesRef.current = ov;
        bump();
      } else {
        localOp(op, true);
      }
      sendCanvasOp(pid, op, origin.current);
    },
    [pid, localOp, bump],
  );

  // Receive authoritative state snapshots + cursors.
  useEffect(() => {
    const unsub = subscribe((msg: any) => {
      if (msg.type === "canvas.state" && msg.doc) {
        const map: Record<string, CanvasShape> = {};
        for (const s of (msg.doc.shapes ?? []) as CanvasShape[]) map[s.id] = s;
        // Retire committed overrides the snapshot has caught up to (or that have
        // outlived the confirm window, so a concurrent edit can't wedge one).
        // In-progress overrides (committedAt null) are kept until the gesture ends.
        const ov = overridesRef.current;
        const now = Date.now();
        let changed = false;
        for (const [id, o] of Object.entries(ov)) {
          if (o.committedAt === null) continue;
          const confirmed = o.shape === null ? map[id] === undefined : shapeEq(map[id], o.shape);
          if (confirmed || now - o.committedAt > OVERRIDE_TTL) {
            delete ov[id];
            changed = true;
          }
        }
        setServerShapes(map);
        if (changed) bump();
        hydratedRef.current = true;
        return;
      }
      if (msg.type === "canvas.cursor" && msg.origin !== origin.current) {
        const key = msg.origin || msg.userId;
        if (!key) return;
        if (!msg.cursor) {
          setCursors((c) => {
            const next = { ...c };
            delete next[key];
            return next;
          });
          return;
        }
        setCursors((c) => ({
          ...c,
          [key]: {
            x: msg.cursor.x,
            y: msg.cursor.y,
            name: msg.cursor.name ?? msg.username ?? "Someone",
            color: msg.cursor.color ?? originColor(key),
            ts: Date.now(),
          },
        }));
      }
    });
    return unsub;
  }, []);

  // Prune stale cursors.
  useEffect(() => {
    const t = setInterval(() => {
      const now = Date.now();
      setCursors((c) => {
        let changed = false;
        const next: Record<string, Cursor> = {};
        for (const [k, v] of Object.entries(c)) {
          // Agent cursors have no heartbeat, so expire them faster than
          // live human pointers (which keep refreshing ts on move).
          const ttl = k === "agent" ? 2500 : 5000;
          if (now - v.ts < ttl) next[k] = v;
          else changed = true;
        }
        return changed ? next : c;
      });
    }, 500);
    return () => clearInterval(t);
  }, []);

  // Ease rendered cursor positions toward their targets. Restarts whenever a
  // target changes and self-stops once everything has settled.
  useEffect(() => {
    let raf = 0;
    let alive = true;
    const step = () => {
      if (!alive) return;
      const targets = cursorsRef.current;
      const disp = cursorPosRef.current;
      for (const k of Object.keys(disp)) if (!targets[k]) delete disp[k];
      let moving = false;
      for (const k in targets) {
        const t = targets[k]!;
        const d = disp[k] ?? { x: t.x, y: t.y };
        const nx = d.x + (t.x - d.x) * 0.3;
        const ny = d.y + (t.y - d.y) * 0.3;
        const settled = Math.hypot(t.x - nx, t.y - ny) < 0.3;
        disp[k] = settled ? { x: t.x, y: t.y } : { x: nx, y: ny };
        if (!settled) moving = true;
      }
      setCursorFrame((f) => (f + 1) & 0xffff);
      if (moving) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
    };
  }, [cursors]);

  // Keyboard: delete selection / escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editing) return;
      const tgt = e.target as HTMLElement;
      if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA")) return;
      if ((e.key === "Delete" || e.key === "Backspace") && selectedIds.length) {
        e.preventDefault();
        for (const id of selectedIds) commit({ kind: "delete", id });
        setSelectedIds([]);
      } else if (e.key === "Escape") {
        setSelectedIds([]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedIds, editing, commit]);

  // ── Coordinate helpers ──
  const toWorld = useCallback((clientX: number, clientY: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    const v = viewRef.current;
    const sx = clientX - (rect?.left ?? 0);
    const sy = clientY - (rect?.top ?? 0);
    return { x: (sx - v.tx) / v.scale, y: (sy - v.ty) / v.scale };
  }, []);

  const worldToScreen = (wx: number, wy: number) => ({
    x: wx * view.scale + view.tx,
    y: wy * view.scale + view.ty,
  });

  // ── Pointer gestures ──
  const endGesture = useCallback(() => {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.mode === "create") {
      let shape = shapesRef.current[drag.id];
      if (shape) {
        // If the user merely clicked (no meaningful drag), the shape is still
        // collapsed — snap it to a sensible default size so a plain click
        // places a normal shape instead of an invisible zero-size one.
        const negligible =
          drag.shapeType === "arrow"
            ? Math.hypot((shape.x2 ?? shape.x) - shape.x, (shape.y2 ?? shape.y) - shape.y) < 4
            : (shape.w ?? 0) < 4 && (shape.h ?? 0) < 4;
        if (negligible && drag.def) {
          const props =
            drag.shapeType === "arrow"
              ? { x2: drag.def.x2, y2: drag.def.y2 }
              : { w: drag.def.w, h: drag.def.h };
          localOp({ kind: "update", id: drag.id, props }, false);
          shape = shapesRef.current[drag.id];
        }
        if (shape) {
          sendCanvasOp(pid, { kind: "add", shape }, origin.current);
          markCommitted(drag.id);
        }
      }
    } else if (drag.mode === "move") {
      // Persist the final position of every shape in the (possibly multi-) drag.
      for (const { id } of drag.origs as Array<{ id: string }>) {
        const shape = shapesRef.current[id];
        if (shape) {
          sendCanvasOp(
            pid,
            { kind: "update", id, props: { x: shape.x, y: shape.y, x2: shape.x2, y2: shape.y2 } },
            origin.current,
          );
          markCommitted(id);
        }
      }
    } else if (drag.mode === "resize") {
      const shape = shapesRef.current[drag.id];
      if (shape) {
        const props: Partial<CanvasShape> = { x: shape.x, y: shape.y, w: shape.w, h: shape.h };
        sendCanvasOp(pid, { kind: "update", id: drag.id, props }, origin.current);
        markCommitted(drag.id);
      }
    } else if (drag.mode === "marquee") {
      // Select every shape the final box touches.
      const box = drag.rect as { x: number; y: number; w: number; h: number } | undefined;
      const hits = box
        ? Object.values(shapesRef.current)
            .filter((s) => boxesIntersect(shapeBox(s), box))
            .map((s) => s.id)
        : [];
      setSelectedIds(hits);
      setMarquee(null);
    }
    dragRef.current = null;
    window.removeEventListener("pointermove", onWindowMove);
    window.removeEventListener("pointerup", endGesture);
  }, [pid, localOp, markCommitted]);

  const onWindowMove = useCallback(
    (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const w = toWorld(e.clientX, e.clientY);

      if (drag.mode === "pan") {
        const dx = e.clientX - drag.sx;
        const dy = e.clientY - drag.sy;
        setView((v) => ({ ...v, tx: drag.tx0 + dx, ty: drag.ty0 + dy }));
        return;
      }
      if (drag.mode === "marquee") {
        const rect = {
          x: Math.min(drag.ox, w.x),
          y: Math.min(drag.oy, w.y),
          w: Math.abs(w.x - drag.ox),
          h: Math.abs(w.y - drag.oy),
        };
        drag.rect = rect; // read back by endGesture to compute the selection
        setMarquee(rect);
        return;
      }
      if (drag.mode === "create") {
        if (drag.shapeType === "arrow") {
          localOp({ kind: "update", id: drag.id, props: { x2: w.x, y2: w.y } }, false);
        } else if (drag.shapeType === "rect" || drag.shapeType === "ellipse") {
          const x = Math.min(drag.ox, w.x);
          const y = Math.min(drag.oy, w.y);
          localOp(
            {
              kind: "update",
              id: drag.id,
              props: { x, y, w: Math.abs(w.x - drag.ox), h: Math.abs(w.y - drag.oy) },
            },
            false,
          );
        }
        return;
      }
      if (drag.mode === "move") {
        const dx = w.x - drag.wx;
        const dy = w.y - drag.wy;
        for (const { id, orig } of drag.origs as Array<{ id: string; orig: CanvasShape }>) {
          const props: Partial<CanvasShape> =
            orig.type === "arrow"
              ? { x: orig.x + dx, y: orig.y + dy, x2: (orig.x2 ?? 0) + dx, y2: (orig.y2 ?? 0) + dy }
              : { x: orig.x + dx, y: orig.y + dy };
          localOp({ kind: "update", id, props }, false);
        }
        return;
      }
      if (drag.mode === "resize") {
        const o = drag.orig as CanvasShape;
        localOp(
          {
            kind: "update",
            id: drag.id,
            props: { w: Math.max(24, w.x - o.x), h: Math.max(24, w.y - o.y) },
          },
          false,
        );
      }
    },
    [toWorld, localOp],
  );

  const beginGesture = (drag: any) => {
    dragRef.current = drag;
    window.addEventListener("pointermove", onWindowMove);
    window.addEventListener("pointerup", endGesture);
  };

  const onBackgroundPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    setEditing(null);
    const w = toWorld(e.clientX, e.clientY);
    if (tool === "select") {
      setSelectedIds([]);
      beginGesture({ mode: "pan", sx: e.clientX, sy: e.clientY, tx0: view.tx, ty0: view.ty });
      return;
    }
    if (tool === "marquee") {
      setSelectedIds([]);
      setMarquee({ x: w.x, y: w.y, w: 0, h: 0 });
      beginGesture({ mode: "marquee", ox: w.x, oy: w.y });
      return;
    }
    const def = defaultShape(tool, w.x, w.y, color);
    if (tool === "rect" || tool === "ellipse" || tool === "arrow") {
      // Start the shape collapsed so the drag sizes it from the click point —
      // a click without a drag falls back to `def` dims in endGesture. This
      // avoids the "appears full-size then snaps small" flash.
      const shape: CanvasShape =
        tool === "arrow" ? { ...def, x2: w.x, y2: w.y } : { ...def, w: 0, h: 0 };
      localOp({ kind: "add", shape }, false);
      setSelectedIds([shape.id]);
      beginGesture({ mode: "create", id: shape.id, shapeType: tool, ox: w.x, oy: w.y, def });
    } else {
      // text — placed at click, no drag sizing; commit immediately.
      localOp({ kind: "add", shape: def }, true);
      setSelectedIds([def.id]);
      sendCanvasOp(pid, { kind: "add", shape: def }, origin.current);
      setTool("select");
    }
  };

  const onShapePointerDown = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    // Grabbing a shape that's part of a multi-selection drags the whole group;
    // grabbing any other shape selects just it.
    const keepGroup = selectedSet.has(id) && selectedIds.length > 1;
    if (!keepGroup) setSelectedIds([id]);
    if (!isSelectTool(tool)) return;
    const w = toWorld(e.clientX, e.clientY);
    const origs = (keepGroup ? selectedIds : [id])
      .map((sid) => shapesRef.current[sid])
      .filter((s): s is CanvasShape => !!s)
      .map((s) => ({ id: s.id, orig: s }));
    if (!origs.length) return;
    beginGesture({ mode: "move", wx: w.x, wy: w.y, origs });
  };

  const onResizePointerDown = (e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    const orig = shapesRef.current[id];
    if (!orig) return;
    beginGesture({ mode: "resize", id, orig });
  };

  const onWheel = (e: React.WheelEvent) => {
    const rect = svgRef.current?.getBoundingClientRect();
    const sx = e.clientX - (rect?.left ?? 0);
    const sy = e.clientY - (rect?.top ?? 0);
    setView((v) => {
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      const scale = Math.min(MAX, Math.max(MIN, v.scale * factor));
      const wx = (sx - v.tx) / v.scale;
      const wy = (sy - v.ty) / v.scale;
      return { scale, tx: sx - wx * scale, ty: sy - wy * scale };
    });
  };

  const onCanvasPointerMove = (e: React.PointerEvent) => {
    const now = Date.now();
    if (now - lastCursorRef.current < 50) return;
    lastCursorRef.current = now;
    const w = toWorld(e.clientX, e.clientY);
    sendCanvasCursor(pid, origin.current, {
      x: w.x,
      y: w.y,
      name: username,
      color: originColor(origin.current),
    });
    // While dragging move/resize, stream throttled updates so others see it live.
    const drag = dragRef.current;
    if (drag && (drag.mode === "move" || drag.mode === "resize" || drag.mode === "create")) {
      if (now - lastMoveRef.current > 60) {
        lastMoveRef.current = now;
        const ids: string[] =
          drag.mode === "move" ? (drag.origs as Array<{ id: string }>).map((o) => o.id) : [drag.id];
        for (const id of ids) {
          const shape = shapesRef.current[id];
          if (shape) {
            sendCanvasOp(
              pid,
              { kind: "update", id, props: { x: shape.x, y: shape.y, w: shape.w, h: shape.h, x2: shape.x2, y2: shape.y2 } },
              origin.current,
            );
          }
        }
      }
    }
  };

  const setShapeColor = (key: ColorKey) => {
    setColor(key);
    for (const id of selectedIds) {
      if (shapesRef.current[id]) commit({ kind: "update", id, props: { color: key } });
    }
  };

  const onEditText = (id: string, text: string) => {
    // Active override while editing (held until the editor closes), plus a
    // throttled live send so others watch the text appear as it's typed.
    localOp({ kind: "update", id, props: { text } }, false);
    const now = Date.now();
    if (now - lastTextRef.current > 80) {
      lastTextRef.current = now;
      sendCanvasOp(pid, { kind: "update", id, props: { text } }, origin.current);
    }
  };
  const onEditTextCommit = (id: string) => {
    const s = shapesRef.current[id];
    // Always send the final value — the last throttled keystroke may have been
    // skipped — then let the next snapshot retire the override.
    if (s) {
      sendCanvasOp(pid, { kind: "update", id, props: { text: s.text ?? "" } }, origin.current);
      markCommitted(id);
    }
  };

  // Download the server-rendered PNG of the current board. The endpoint streams
  // the same render the agent sees; we turn it into a blob and click a throwaway
  // <a download> so the browser saves it locally.
  const exportPng = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const res = await fetch(`/api/projects/${pid}/canvas/export`, { credentials: "include" });
      if (!res.ok) throw new Error(`export failed: ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "canvas.png";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
    } finally {
      setExporting(false);
    }
  };

  const list = Object.values(shapes);

  return (
    <div className="flex h-full min-h-0 flex-col select-none">
      {/* Toolbar */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border/40 px-2 py-1.5">
        {TOOLS.map(({ tool: t, icon: Icon, label }) => (
          <button
            key={t}
            title={label}
            onClick={() => setTool(t)}
            className={cn(
              "flex size-8 items-center justify-center rounded-md hover:bg-muted",
              tool === t && "bg-muted text-foreground ring-1 ring-border",
            )}
          >
            <Icon className="size-4" />
          </button>
        ))}
        <div className="mx-1 h-5 w-px bg-border/60" />
        {COLOR_KEYS.map((k) => (
          <button
            key={k}
            title={k}
            onClick={() => setShapeColor(k)}
            className={cn(
              "size-5 rounded-full border",
              color === k ? "ring-2 ring-foreground ring-offset-1 ring-offset-background" : "border-border",
            )}
            style={{ background: PALETTE[k].fill, borderColor: PALETTE[k].stroke }}
          />
        ))}
        <div className="mx-1 h-5 w-px bg-border/60" />
        <button
          title="Erase selected"
          disabled={selectedIds.length === 0}
          onClick={() => {
            if (selectedIds.length) {
              for (const id of selectedIds) commit({ kind: "delete", id });
              setSelectedIds([]);
            }
          }}
          className="flex size-8 items-center justify-center rounded-md hover:bg-muted disabled:opacity-40"
        >
          <EraserIcon className="size-4" />
        </button>
        <button
          title="Clear board"
          onClick={() => setConfirmClearOpen(true)}
          className="flex size-8 items-center justify-center rounded-md hover:bg-muted"
        >
          <Trash2Icon className="size-4" />
        </button>
        <div className="mx-1 h-5 w-px bg-border/60" />
        <button
          title="Export as PNG"
          disabled={exporting}
          onClick={exportPng}
          className="flex size-8 items-center justify-center rounded-md hover:bg-muted disabled:opacity-40"
        >
          <DownloadIcon className="size-4" />
        </button>
        <div className="ml-auto pr-1 text-xs tabular-nums text-muted-foreground">
          {Math.round(view.scale * 100)}%
        </div>
      </div>

      {/* Canvas */}
      <div className="relative min-h-0 flex-1 overflow-hidden bg-muted/20">
        <svg
          ref={svgRef}
          className="absolute inset-0 h-full w-full touch-none"
          style={{ cursor: tool === "select" ? "default" : "crosshair" }}
          onPointerDown={onBackgroundPointerDown}
          onPointerMove={onCanvasPointerMove}
          onWheel={onWheel}
        >
          <g transform={`translate(${view.tx} ${view.ty}) scale(${view.scale})`}>
            {list.map((s) => (
              <ShapeView
                key={s.id}
                shape={s}
                selected={selectedSet.has(s.id)}
                resizable={selectedIds.length === 1 && selectedSet.has(s.id)}
                onPointerDown={(e) => onShapePointerDown(e, s.id)}
                onDoubleClick={() => {
                  if (s.type !== "arrow") setEditing(s.id);
                }}
                onResizeDown={(e) => onResizePointerDown(e, s.id)}
              />
            ))}

            {/* Live rectangle-select box */}
            {marquee && (
              <rect
                x={marquee.x}
                y={marquee.y}
                width={marquee.w}
                height={marquee.h}
                fill="#3b82f6"
                fillOpacity={0.08}
                stroke="#3b82f6"
                strokeWidth={1 / view.scale}
                strokeDasharray={`${4 / view.scale} ${3 / view.scale}`}
                pointerEvents="none"
              />
            )}

            {/* Live contributor cursors (humans by pointer, agent by op anchor) */}
            {Object.entries(cursors).map(([k, c]) => {
              const inv = 1 / view.scale;
              const working = c.workingTs !== undefined && Date.now() - c.workingTs < 1600;
              const label = k === "agent" ? "Agent" : c.name;
              const labelText = working ? `${label} ✎` : label;
              const pillW = (labelText.length * 6.4 + 10) * inv;
              // Render at the eased position (see the rAF loop), so the agent
              // cursor always glides shape-to-shape instead of teleporting.
              const pos = cursorPosRef.current[k] ?? { x: c.x, y: c.y };
              return (
                <g key={k} transform={`translate(${pos.x} ${pos.y})`} pointerEvents="none">
                  {working && (
                    <circle cx={0} cy={0} r={5 * inv} fill="none" stroke={c.color} strokeWidth={1.5 * inv}>
                      <animate
                        attributeName="r"
                        values={`${4 * inv};${15 * inv};${4 * inv}`}
                        dur="1.3s"
                        repeatCount="indefinite"
                      />
                      <animate attributeName="opacity" values="0.6;0;0.6" dur="1.3s" repeatCount="indefinite" />
                    </circle>
                  )}
                  <path
                    d="M0 0 L0 16 L4 12 L7 18 L9 17 L6 11 L11 11 Z"
                    fill={c.color}
                    stroke="white"
                    strokeWidth={1 / view.scale}
                    transform={`scale(${1 / view.scale})`}
                  />
                  <g transform={`translate(${13 * inv} ${3 * inv})`}>
                    <rect x={0} y={0} rx={3 * inv} width={pillW} height={15 * inv} fill={c.color} />
                    <text x={5 * inv} y={11.5 * inv} fontSize={10.5 * inv} fill="white" style={{ fontWeight: 600 }}>
                      {labelText}
                    </text>
                  </g>
                </g>
              );
            })}
          </g>
        </svg>

        {/* Text editor overlay */}
        {editing && shapes[editing] && (
          <TextEditor
            shape={shapes[editing]!}
            view={view}
            worldToScreen={worldToScreen}
            onChange={(t) => onEditText(editing, t)}
            onClose={() => {
              onEditTextCommit(editing);
              setEditing(null);
            }}
          />
        )}

        {list.length === 0 && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <p className="text-sm text-muted-foreground">
              Pick a tool and click to start — or ask the agent to draw here.
            </p>
          </div>
        )}
      </div>

      <AlertDialog open={confirmClearOpen} onOpenChange={setConfirmClearOpen}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Clear board</AlertDialogTitle>
            <AlertDialogDescription>
              Clear the entire board for everyone? This removes every shape and cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                commit({ kind: "clear" });
                setSelectedIds([]);
              }}
            >
              Clear board
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ── Shape rendering ──────────────────────────────────────────────────

function ShapeView({
  shape,
  selected,
  resizable,
  onPointerDown,
  onDoubleClick,
  onResizeDown,
}: {
  shape: CanvasShape;
  selected: boolean;
  resizable: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  onDoubleClick: () => void;
  onResizeDown: (e: React.PointerEvent) => void;
}) {
  const c = colorOf(shape);
  const seed = useMemo(() => seedOf(shape.id), [shape.id]);

  // Hand-drawn (rough.js) path data — regenerated only when the geometry or
  // color changes, so the sketchiness stays stable across unrelated renders.
  const paths = useMemo(() => {
    const base = { seed, roughness: 1.15, bowing: 1, stroke: c.stroke, strokeWidth: 1.8 };

    if (shape.type === "arrow") {
      const x1 = shape.x;
      const y1 = shape.y;
      const x2 = shape.x2 ?? shape.x + 100;
      const y2 = shape.y2 ?? shape.y;
      const ang = Math.atan2(y2 - y1, x2 - x1);
      const len = Math.hypot(x2 - x1, y2 - y1);
      const head = Math.min(20, len * 0.4);
      const spread = Math.PI / 7;
      const hx1 = x2 - head * Math.cos(ang - spread);
      const hy1 = y2 - head * Math.sin(ang - spread);
      const hx2 = x2 - head * Math.cos(ang + spread);
      const hy2 = y2 - head * Math.sin(ang + spread);
      return [
        roughGen.line(x1, y1, x2, y2, base),
        roughGen.linearPath(
          [
            [hx1, hy1],
            [x2, y2],
            [hx2, hy2],
          ],
          base,
        ),
      ].flatMap((d) => roughGen.toPaths(d));
    }

    const w = shape.w ?? 120;
    const h = shape.h ?? 80;
    if (w <= 0 || h <= 0 || shape.type === "text") return []; // text = label only, no box
    const fillOpts = { ...base, fill: c.fill, fillStyle: "solid" as const, fillWeight: 2 };
    const drawable =
      shape.type === "ellipse"
        ? roughGen.ellipse(shape.x + w / 2, shape.y + h / 2, w, h, fillOpts)
        : roughGen.path(roundRectPath(shape.x, shape.y, w, h, 12), fillOpts);
    return roughGen.toPaths(drawable);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape.type, shape.x, shape.y, shape.w, shape.h, shape.x2, shape.y2, shape.color, seed]);

  if (shape.type === "arrow") {
    const x2 = shape.x2 ?? shape.x + 100;
    const y2 = shape.y2 ?? shape.y;
    return (
      <g onPointerDown={onPointerDown} style={{ cursor: "move" }}>
        {/* fat invisible hit line */}
        <line x1={shape.x} y1={shape.y} x2={x2} y2={y2} stroke="transparent" strokeWidth={16} />
        {paths.map((p, i) => (
          <path
            key={i}
            d={p.d}
            stroke={p.stroke}
            strokeWidth={(p.strokeWidth ?? 1.8) * (selected ? 1.7 : 1)}
            fill={p.fill ?? "none"}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
      </g>
    );
  }

  const w = shape.w ?? 120;
  const h = shape.h ?? 80;
  const isText = shape.type === "text";

  return (
    <g onPointerDown={onPointerDown} onDoubleClick={onDoubleClick} style={{ cursor: "move" }}>
      {/* invisible hit area so the whole bounding box is grabbable */}
      <rect x={shape.x} y={shape.y} width={Math.max(w, 1)} height={Math.max(h, 1)} fill="transparent" />
      {paths.map((p, i) => (
        <path
          key={i}
          d={p.d}
          stroke={p.stroke}
          strokeWidth={p.strokeWidth}
          fill={p.fill ?? "none"}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
      <foreignObject x={shape.x} y={shape.y} width={Math.max(w, 1)} height={Math.max(h, 1)} pointerEvents="none">
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            alignItems: isText ? "flex-start" : "center",
            justifyContent: "center",
            padding: 10,
            boxSizing: "border-box",
            color: c.text,
            fontFamily: HAND_FONT,
            fontSize: 17,
            lineHeight: 1.25,
            textAlign: "center",
            overflow: "hidden",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {shape.text || ""}
        </div>
      </foreignObject>
      {selected && (
        <rect
          x={shape.x - 2}
          y={shape.y - 2}
          width={w + 4}
          height={h + 4}
          rx={isText ? 4 : 10}
          fill="none"
          stroke="#3b82f6"
          strokeWidth={1.5}
          strokeDasharray="4 3"
          pointerEvents="none"
        />
      )}
      {resizable && (
        <rect
          x={shape.x + w - 6}
          y={shape.y + h - 6}
          width={12}
          height={12}
          fill="#3b82f6"
          style={{ cursor: "nwse-resize" }}
          onPointerDown={onResizeDown}
        />
      )}
    </g>
  );
}

// ── Text editing overlay ─────────────────────────────────────────────

function TextEditor({
  shape,
  view,
  worldToScreen,
  onChange,
  onClose,
}: {
  shape: CanvasShape;
  view: View;
  worldToScreen: (x: number, y: number) => { x: number; y: number };
  onChange: (text: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const pos = worldToScreen(shape.x, shape.y);
  const w = (shape.w ?? 120) * view.scale;
  const h = (shape.h ?? 80) * view.scale;
  const c = colorOf(shape);

  return (
    <textarea
      ref={ref}
      defaultValue={shape.text ?? ""}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
        e.stopPropagation();
      }}
      style={{
        position: "absolute",
        left: pos.x,
        top: pos.y,
        width: w,
        height: h,
        padding: 8,
        boxSizing: "border-box",
        resize: "none",
        userSelect: "text",
        border: "1px solid #3b82f6",
        borderRadius: shape.type === "text" ? 4 : 10,
        background: shape.type === "text" ? "var(--background)" : c.fill,
        color: c.text,
        fontFamily: HAND_FONT,
        fontSize: 17 * view.scale,
        lineHeight: 1.25,
        textAlign: "center",
        outline: "none",
        overflow: "hidden",
      }}
    />
  );
}
