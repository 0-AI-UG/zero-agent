import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { useParams } from "react-router";
import { nanoid } from "nanoid";
import rough from "roughjs";
import {
  MousePointer2Icon,
  StickyNoteIcon,
  SquareIcon,
  CircleIcon,
  TypeIcon,
  MoveUpRightIcon,
  Trash2Icon,
  EraserIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth";
import { subscribe, sendCanvasOp, sendCanvasCursor } from "@/lib/ws";
import {
  useCanvas,
  applyOpToShapes,
  type CanvasShape,
  type CanvasShapeType,
  type CanvasOp,
} from "@/api/canvas";

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

type Tool = "select" | CanvasShapeType;

const TOOLS: { tool: Tool; icon: typeof SquareIcon; label: string }[] = [
  { tool: "select", icon: MousePointer2Icon, label: "Select / pan" },
  { tool: "note", icon: StickyNoteIcon, label: "Sticky note" },
  { tool: "rect", icon: SquareIcon, label: "Rectangle" },
  { tool: "ellipse", icon: CircleIcon, label: "Ellipse" },
  { tool: "text", icon: TypeIcon, label: "Text" },
  { tool: "arrow", icon: MoveUpRightIcon, label: "Arrow" },
];

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

const AGENT_COLOR = "oklch(0.62 0.2 295)"; // violet — distinct from human cursors

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

// Anchor point (top-left) + bounding box of a shape, for op-derived cursors
// and the new-shape flash highlight.
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
  if (type === "note") return { id, type, x, y, w: 180, h: 130, text: "", color };
  if (type === "ellipse") return { id, type, x, y, w: 130, h: 130, text: "", color };
  return { id, type, x, y, w: 170, h: 110, text: "", color }; // rect
}

// ── Component ────────────────────────────────────────────────────────

export function CanvasPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const pid = projectId!;
  const username = useAuthStore((s) => s.user?.username) ?? "Someone";

  const { data: doc } = useCanvas(pid);

  const origin = useRef<string>(nanoid());
  const [shapes, setShapes] = useState<Record<string, CanvasShape>>({});
  const [tool, setTool] = useState<Tool>("select");
  const [color, setColor] = useState<ColorKey>("yellow");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [view, setView] = useState<View>({ tx: 0, ty: 0, scale: 1 });
  const [cursors, setCursors] = useState<Record<string, Cursor>>({});
  // shapeId -> { ts, color } for the brief "just drawn/changed" flash.
  const [flash, setFlash] = useState<Record<string, { ts: number; color: string }>>({});
  // shapeId -> ts driving the scale/fade entrance of a remote-added shape.
  const [entering, setEntering] = useState<Record<string, number>>({});
  // Remote ADD ops are queued and replayed one-at-a-time so a burst of
  // parallel agent tool-calls reveals as a smooth drawing sequence (cursor
  // leading) instead of every shape popping in at once.
  const pendingAddsRef = useRef<Array<{ op: Extract<CanvasOp, { kind: "add" }>; key: string }>>([]);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const shapesRef = useRef(shapes);
  shapesRef.current = shapes;
  const viewRef = useRef(view);
  viewRef.current = view;
  const dragRef = useRef<any>(null);
  const lastCursorRef = useRef(0);
  const lastMoveRef = useRef(0);
  const hydratedRef = useRef(false);
  // Cursor position smoothing. `cursors` holds the *target* positions; a rAF
  // loop eases the *rendered* positions toward them so every contributor's
  // cursor (especially the agent's shape-to-shape hops) always glides rather
  // than teleports — independent of flaky CSS transform transitions on SVG.
  const cursorsRef = useRef(cursors);
  cursorsRef.current = cursors;
  const cursorPosRef = useRef<Record<string, { x: number; y: number }>>({});
  const [, setCursorFrame] = useState(0);

  // Hydrate once from the REST snapshot; the WS stream keeps it live after.
  useEffect(() => {
    if (hydratedRef.current || !doc) return;
    const map: Record<string, CanvasShape> = {};
    for (const s of doc.shapes) map[s.id] = s;
    setShapes(map);
    hydratedRef.current = true;
  }, [doc]);

  const applyLocal = useCallback((op: CanvasOp) => {
    setShapes((s) => applyOpToShapes(s, op));
  }, []);

  // Move a contributor's cursor onto a shape + flash it.
  const markActivity = useCallback((key: string, target: CanvasShape) => {
    const isAgent = key === "agent";
    const box = shapeBox(target);
    const col = isAgent ? AGENT_COLOR : originColor(key);
    const now = Date.now();
    setCursors((c) => {
      const prev = c[key];
      // Humans have a live pointer cursor; only the agent (no pointer) is
      // anchored to the shape it just touched.
      const pos = isAgent || !prev ? { x: box.x, y: box.y } : { x: prev.x, y: prev.y };
      return {
        ...c,
        [key]: { ...pos, name: isAgent ? "Agent" : prev?.name ?? "Someone", color: col, ts: now, workingTs: now },
      };
    });
    setFlash((f) => ({ ...f, [target.id]: { ts: now, color: col } }));
  }, []);

  const revealAdd = useCallback(
    (op: Extract<CanvasOp, { kind: "add" }>, key: string) => {
      applyLocal(op);
      markActivity(key, op.shape);
      setEntering((e) => ({ ...e, [op.shape.id]: Date.now() }));
    },
    [applyLocal, markActivity],
  );

  // Drain queued remote adds one at a time — the "drawing playback". Reveal
  // strictly one shape per tick so it reads as the agent placing them in
  // sequence; only compress the gap when a big batch is backed up so a huge
  // diagram doesn't take minutes. Self-scheduling so the delay can adapt.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const q = pendingAddsRef.current;
      const item = q.shift();
      if (item) revealAdd(item.op, item.key);
      const n = pendingAddsRef.current.length;
      // Comfortable, watchable pace for normal diagrams; speed up under heavy
      // backlog. Idle polling falls back to the slow cadence.
      const delay = n > 40 ? 110 : n > 15 ? 240 : 420;
      timer = setTimeout(tick, delay);
    };
    timer = setTimeout(tick, 420);
    return () => clearTimeout(timer);
  }, [revealAdd]);

  const commit = useCallback(
    (op: CanvasOp) => {
      setShapes((s) => applyOpToShapes(s, op));
      sendCanvasOp(pid, op, origin.current);
    },
    [pid],
  );

  // Receive remote ops + cursors.
  useEffect(() => {
    const unsub = subscribe((msg: any) => {
      if (msg.type === "canvas.op" && msg.origin !== origin.current && msg.op) {
        const op = msg.op as CanvasOp;
        const key: string = msg.origin || "agent";
        if (op.kind === "add") {
          // Queue for sequenced playback (drain timer above).
          pendingAddsRef.current.push({ op, key });
        } else {
          // Updates/deletes/clears apply immediately so live drags stay smooth.
          const target = op.kind === "update" || op.kind === "delete" ? shapesRef.current[op.id] : undefined;
          applyLocal(op);
          if (op.kind === "update" && target) markActivity(key, target);
        }
      } else if (msg.type === "canvas.cursor" && msg.origin !== origin.current) {
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
  }, [applyLocal, markActivity]);

  // Prune stale cursors + finished flashes.
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
      setFlash((f) => {
        let changed = false;
        const next: Record<string, { ts: number; color: string }> = {};
        for (const [k, v] of Object.entries(f)) {
          if (now - v.ts < 1000) next[k] = v;
          else changed = true;
        }
        return changed ? next : f;
      });
      setEntering((e) => {
        let changed = false;
        const next: Record<string, number> = {};
        for (const [k, v] of Object.entries(e)) {
          if (now - v < 500) next[k] = v;
          else changed = true;
        }
        return changed ? next : e;
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
      if ((e.key === "Delete" || e.key === "Backspace") && selectedId) {
        e.preventDefault();
        commit({ kind: "delete", id: selectedId });
        setSelectedId(null);
      } else if (e.key === "Escape") {
        setSelectedId(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId, editing, commit]);

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
          applyLocal({ kind: "update", id: drag.id, props });
          shape = shapesRef.current[drag.id];
        }
        if (shape) sendCanvasOp(pid, { kind: "add", shape }, origin.current);
      }
    } else if (drag.mode === "move" || drag.mode === "resize") {
      const shape = shapesRef.current[drag.id];
      if (shape) {
        const props: Partial<CanvasShape> = {
          x: shape.x,
          y: shape.y,
          w: shape.w,
          h: shape.h,
          x2: shape.x2,
          y2: shape.y2,
        };
        sendCanvasOp(pid, { kind: "update", id: drag.id, props }, origin.current);
      }
    }
    dragRef.current = null;
    window.removeEventListener("pointermove", onWindowMove);
    window.removeEventListener("pointerup", endGesture);
  }, [pid, applyLocal]);

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
      if (drag.mode === "create") {
        if (drag.shapeType === "arrow") {
          applyLocal({ kind: "update", id: drag.id, props: { x2: w.x, y2: w.y } });
        } else if (drag.shapeType === "rect" || drag.shapeType === "ellipse") {
          const x = Math.min(drag.ox, w.x);
          const y = Math.min(drag.oy, w.y);
          applyLocal({
            kind: "update",
            id: drag.id,
            props: { x, y, w: Math.abs(w.x - drag.ox), h: Math.abs(w.y - drag.oy) },
          });
        }
        return;
      }
      if (drag.mode === "move") {
        const dx = w.x - drag.wx;
        const dy = w.y - drag.wy;
        const o = drag.orig as CanvasShape;
        const props: Partial<CanvasShape> =
          o.type === "arrow"
            ? { x: o.x + dx, y: o.y + dy, x2: (o.x2 ?? 0) + dx, y2: (o.y2 ?? 0) + dy }
            : { x: o.x + dx, y: o.y + dy };
        applyLocal({ kind: "update", id: drag.id, props });
        return;
      }
      if (drag.mode === "resize") {
        const o = drag.orig as CanvasShape;
        applyLocal({
          kind: "update",
          id: drag.id,
          props: { w: Math.max(24, w.x - o.x), h: Math.max(24, w.y - o.y) },
        });
      }
    },
    [toWorld, applyLocal],
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
      setSelectedId(null);
      beginGesture({ mode: "pan", sx: e.clientX, sy: e.clientY, tx0: view.tx, ty0: view.ty });
      return;
    }
    const def = defaultShape(tool, w.x, w.y, color);
    if (tool === "rect" || tool === "ellipse" || tool === "arrow") {
      // Start the shape collapsed so the drag sizes it from the click point —
      // a click without a drag falls back to `def` dims in endGesture. This
      // avoids the "appears full-size then snaps small" flash.
      const shape: CanvasShape =
        tool === "arrow" ? { ...def, x2: w.x, y2: w.y } : { ...def, w: 0, h: 0 };
      applyLocal({ kind: "add", shape });
      setSelectedId(shape.id);
      beginGesture({ mode: "create", id: shape.id, shapeType: tool, ox: w.x, oy: w.y, def });
    } else {
      // note / text — placed at click, no drag sizing; commit immediately.
      applyLocal({ kind: "add", shape: def });
      setSelectedId(def.id);
      sendCanvasOp(pid, { kind: "add", shape: def }, origin.current);
      setTool("select");
    }
  };

  const onShapePointerDown = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    setSelectedId(id);
    if (tool !== "select") return;
    const w = toWorld(e.clientX, e.clientY);
    const orig = shapesRef.current[id];
    if (!orig) return;
    beginGesture({ mode: "move", id, wx: w.x, wy: w.y, orig });
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
        const shape = shapesRef.current[drag.id];
        if (shape) {
          sendCanvasOp(
            pid,
            { kind: "update", id: drag.id, props: { x: shape.x, y: shape.y, w: shape.w, h: shape.h, x2: shape.x2, y2: shape.y2 } },
            origin.current,
          );
        }
      }
    }
  };

  const setShapeColor = (key: ColorKey) => {
    setColor(key);
    if (selectedId && shapesRef.current[selectedId]) {
      commit({ kind: "update", id: selectedId, props: { color: key } });
    }
  };

  const onEditText = (id: string, text: string) => {
    applyLocal({ kind: "update", id, props: { text } });
  };
  const onEditTextCommit = (id: string) => {
    const s = shapesRef.current[id];
    if (s) sendCanvasOp(pid, { kind: "update", id, props: { text: s.text ?? "" } }, origin.current);
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
          title="Delete selected"
          disabled={!selectedId}
          onClick={() => {
            if (selectedId) {
              commit({ kind: "delete", id: selectedId });
              setSelectedId(null);
            }
          }}
          className="flex size-8 items-center justify-center rounded-md hover:bg-muted disabled:opacity-40"
        >
          <Trash2Icon className="size-4" />
        </button>
        <button
          title="Clear board"
          onClick={() => {
            if (confirm("Clear the entire board for everyone?")) commit({ kind: "clear" });
          }}
          className="flex size-8 items-center justify-center rounded-md hover:bg-muted"
        >
          <EraserIcon className="size-4" />
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
                selected={s.id === selectedId}
                entering={entering[s.id] !== undefined}
                onPointerDown={(e) => onShapePointerDown(e, s.id)}
                onDoubleClick={() => {
                  if (s.type !== "arrow") setEditing(s.id);
                }}
                onResizeDown={(e) => onResizePointerDown(e, s.id)}
              />
            ))}

            {/* Flash ring on shapes a remote contributor just drew/changed */}
            {Object.entries(flash).map(([id, fl]) => {
              const s = shapes[id];
              if (!s) return null;
              const b = shapeBox(s);
              const inv = 1 / view.scale;
              const pad = 6 * inv;
              return (
                <rect
                  key={`${id}-${fl.ts}`}
                  x={b.x - pad}
                  y={b.y - pad}
                  width={b.w + pad * 2}
                  height={b.h + pad * 2}
                  rx={12 * inv}
                  fill="none"
                  stroke={fl.color}
                  pointerEvents="none"
                >
                  <animate attributeName="opacity" from="0.9" to="0" dur="0.9s" fill="freeze" />
                  <animate
                    attributeName="stroke-width"
                    from={4 * inv}
                    to={1.2 * inv}
                    dur="0.9s"
                    fill="freeze"
                  />
                </rect>
              );
            })}

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
    </div>
  );
}

// ── Shape rendering ──────────────────────────────────────────────────

function ShapeView({
  shape,
  selected,
  entering,
  onPointerDown,
  onDoubleClick,
  onResizeDown,
}: {
  shape: CanvasShape;
  selected: boolean;
  entering: boolean;
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

  // Fade a remote-added shape in (plays once on mount via SMIL).
  const enter = entering ? (
    <animate attributeName="opacity" from="0" to="1" dur="0.28s" fill="freeze" />
  ) : null;

  if (shape.type === "arrow") {
    const x2 = shape.x2 ?? shape.x + 100;
    const y2 = shape.y2 ?? shape.y;
    return (
      <g onPointerDown={onPointerDown} style={{ cursor: "move" }}>
        {enter}
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
      {enter}
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
        <>
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
          <rect
            x={shape.x + w - 6}
            y={shape.y + h - 6}
            width={12}
            height={12}
            fill="#3b82f6"
            style={{ cursor: "nwse-resize" }}
            onPointerDown={onResizeDown}
          />
        </>
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
