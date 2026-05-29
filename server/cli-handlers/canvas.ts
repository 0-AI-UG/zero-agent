/**
 * Canvas handlers — let the in-sandbox agent read and draw on the
 * project's collaborative whiteboard via the `zero canvas` CLI/SDK.
 *
 * The agent never handles server ids. It names every shape itself (that
 * name IS the id) and addresses everything by name: `set` upserts a shape,
 * `arrow` connects two by name, `remove` deletes one. The server computes
 * all arrow geometry, so callers never touch coordinates for connectors.
 *
 * Every mutation goes through `applyCanvasOpAndBroadcast`, the exact same
 * path the WebSocket op handler uses, so the agent's edits persist AND
 * stream live to any teammate viewing the Canvas tab. The author tag is
 * "agent" so connected clients don't mistake it for their own echo.
 */
import type { z } from "zod";
import { generateId } from "@/db/index.ts";
import { getCanvasDoc } from "@/db/queries/canvas.ts";
import { applyCanvasOpAndBroadcast } from "@/lib/http/ws.ts";
import { anchorBetween, normalizeShape, type Shape } from "@/lib/canvas/doc.ts";
import type { CliContext } from "./context.ts";
import { ok, fail } from "./response.ts";
import type {
  CanvasSetInput,
  CanvasArrowInput,
  CanvasDrawInput,
  CanvasRemoveInput,
} from "zero/schemas";

const AGENT_ORIGIN = "agent";

type SetInput = z.infer<typeof CanvasSetInput>;
type ArrowInput = z.infer<typeof CanvasArrowInput>;

export async function handleCanvasGet(ctx: CliContext): Promise<Response> {
  const doc = getCanvasDoc(ctx.projectId);
  return ok({ shapes: doc.shapes });
}

/** Upsert one shape by name. New names create; existing names patch in place. */
function upsertShape(
  projectId: string,
  spec: SetInput,
  known: Map<string, Shape>,
): { shape?: Shape; full?: boolean } {
  const existing = known.get(spec.id);
  const op = existing
    ? { kind: "update" as const, id: spec.id, props: stripUndefined(spec) }
    : { kind: "add" as const, shape: normalizeShape({ ...spec, type: spec.type ?? "rect" }) };
  const { changed, doc } = applyCanvasOpAndBroadcast(projectId, op, AGENT_ORIGIN);
  if (!changed && !existing) return { full: true };
  const shape = doc.shapes.find((s) => s.id === spec.id);
  if (shape) known.set(spec.id, shape);
  return { shape };
}

/** Drop id/type and undefined fields so `update` only patches what was sent. */
function stripUndefined(spec: SetInput): Partial<Omit<Shape, "id" | "type">> {
  const { id: _id, type: _type, ...rest } = spec;
  return Object.fromEntries(
    Object.entries(rest).filter(([, v]) => v !== undefined),
  ) as Partial<Omit<Shape, "id" | "type">>;
}

export async function handleCanvasSet(ctx: CliContext, input: SetInput): Promise<Response> {
  const known = new Map(getCanvasDoc(ctx.projectId).shapes.map((s) => [s.id, s]));
  const { shape, full } = upsertShape(ctx.projectId, input, known);
  if (full) return fail("limit", "Canvas is full (max shapes reached)");
  return ok({ shape });
}

/** Connect two named shapes; the server picks edge-anchored endpoints. */
function connect(
  projectId: string,
  input: ArrowInput,
  known: Map<string, Shape>,
): { shape?: Shape; missing?: string } {
  const a = known.get(input.from);
  const b = known.get(input.to);
  if (!a) return { missing: input.from };
  if (!b) return { missing: input.to };
  const shape = normalizeShape({
    id: generateId(),
    type: "arrow",
    text: input.text,
    color: input.color,
    ...anchorBetween(a, b),
  });
  const { doc } = applyCanvasOpAndBroadcast(projectId, { kind: "add", shape }, AGENT_ORIGIN);
  return { shape: doc.shapes.find((s) => s.id === shape.id) ?? shape };
}

export async function handleCanvasArrow(ctx: CliContext, input: ArrowInput): Promise<Response> {
  const known = new Map(getCanvasDoc(ctx.projectId).shapes.map((s) => [s.id, s]));
  const { shape, missing } = connect(ctx.projectId, input, known);
  if (missing) return fail("not_found", `No shape named "${missing}"`);
  return ok({ shape });
}

/**
 * Draw a whole diagram in one call. Shapes are upserted first so arrows can
 * connect to freshly-named shapes; each shape is broadcast individually so
 * teammates watch the diagram appear live.
 */
export async function handleCanvasDraw(
  ctx: CliContext,
  input: z.infer<typeof CanvasDrawInput>,
): Promise<Response> {
  const known = new Map(getCanvasDoc(ctx.projectId).shapes.map((s) => [s.id, s]));
  const created: Shape[] = [];

  const isArrow = (item: (typeof input.items)[number]): item is ArrowInput =>
    "from" in item && "to" in item;

  for (const item of input.items) {
    if (isArrow(item)) continue;
    const { shape, full } = upsertShape(ctx.projectId, item, known);
    if (full) return fail("limit", `Canvas is full after ${created.length} shape(s)`);
    if (shape) created.push(shape);
  }
  for (const item of input.items) {
    if (!isArrow(item)) continue;
    const { shape, missing } = connect(ctx.projectId, item, known);
    if (missing) return fail("not_found", `Arrow references unknown shape "${missing}"`);
    if (shape) created.push(shape);
  }
  return ok({ shapes: created });
}

export async function handleCanvasRemove(
  ctx: CliContext,
  input: z.infer<typeof CanvasRemoveInput>,
): Promise<Response> {
  const { changed } = applyCanvasOpAndBroadcast(
    ctx.projectId,
    { kind: "delete", id: input.id },
    AGENT_ORIGIN,
  );
  return ok({ success: changed });
}

export async function handleCanvasClear(ctx: CliContext): Promise<Response> {
  applyCanvasOpAndBroadcast(ctx.projectId, { kind: "clear" }, AGENT_ORIGIN);
  return ok({ success: true });
}
