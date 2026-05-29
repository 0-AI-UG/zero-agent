/**
 * Canvas document persistence — one whiteboard per project.
 *
 * The doc is stored as a JSON blob; ops are applied in the application
 * layer (`server/lib/canvas/doc.ts`) and the whole doc is written back.
 * better-sqlite3 is synchronous, so each read-modify-write is effectively
 * atomic within a single request.
 */
import { db } from "@/db/index.ts";
import { type CanvasDoc, type CanvasOp, applyCanvasOp, emptyDoc, parseDoc } from "@/lib/canvas/doc.ts";

const getStmt = db.prepare("SELECT doc FROM canvas_documents WHERE project_id = ?");
const upsertStmt = db.prepare(
  `INSERT INTO canvas_documents (project_id, doc, updated_at)
   VALUES (?, ?, datetime('now'))
   ON CONFLICT(project_id) DO UPDATE SET doc = excluded.doc, updated_at = datetime('now')`,
);

export function getCanvasDoc(projectId: string): CanvasDoc {
  const row = getStmt.get(projectId) as { doc: string } | undefined;
  return parseDoc(row?.doc);
}

function writeDoc(projectId: string, doc: CanvasDoc): void {
  upsertStmt.run(projectId, JSON.stringify(doc));
}

/**
 * Apply one op to the project's canvas and persist. Returns the op
 * applied (with any server-assigned ids already baked into the op the
 * caller passed) plus whether the doc actually changed — callers use the
 * latter to decide whether to broadcast.
 */
export function applyAndPersist(projectId: string, op: CanvasOp): { changed: boolean; doc: CanvasDoc } {
  const before = getCanvasDoc(projectId);
  const after = applyCanvasOp(before, op);
  if (after === before) return { changed: false, doc: before };
  const next = { ...after, updatedAt: Date.now() };
  writeDoc(projectId, next);
  return { changed: true, doc: next };
}

export function clearCanvas(projectId: string): void {
  writeDoc(projectId, { ...emptyDoc(), updatedAt: Date.now() });
}
