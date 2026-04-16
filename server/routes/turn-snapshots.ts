/**
 * Routes for per-turn git snapshots (diff, file read, revert).
 *
 * Auth: `authenticateRequest` + `verifyProjectAccess` against the project
 * referenced by the snapshot row. This matches the pattern used in
 * `server/routes/files.ts` and does not assume the client already knows
 * the project id (the snapshot id alone is sufficient to locate it).
 */
import { corsHeaders } from "@/lib/http/cors.ts";
import { authenticateRequest } from "@/lib/auth/auth.ts";
import { getParams } from "@/lib/http/request.ts";
import { handleError, verifyProjectAccess } from "@/routes/utils.ts";
import { ValidationError, NotFoundError } from "@/lib/utils/errors.ts";
import { getTurnSnapshotById } from "@/db/queries/turn-snapshots.ts";
import { getLocalBackend } from "@/lib/execution/lifecycle.ts";

function loadSnapshotForUser(request: Request, userId: string) {
  const { snapshotId } = getParams<{ snapshotId: string }>(request);
  const snapshot = getTurnSnapshotById(snapshotId);
  if (!snapshot) throw new NotFoundError("Snapshot not found");
  verifyProjectAccess(snapshot.project_id, userId);
  return snapshot;
}

export async function handleGetTurnSnapshotDiff(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const snapshot = loadSnapshotForUser(request, userId);

    if (!snapshot.parent_snapshot_id) {
      return Response.json([], { headers: corsHeaders });
    }

    const parent = getTurnSnapshotById(snapshot.parent_snapshot_id);
    if (!parent) {
      // Parent row missing (should not happen — FK-less table). Treat as empty diff.
      return Response.json([], { headers: corsHeaders });
    }

    const backend = getLocalBackend();
    if (!backend || typeof backend.getSnapshotDiff !== "function") {
      throw new ValidationError("Execution backend is unavailable");
    }

    const diff = await backend.getSnapshotDiff(
      snapshot.project_id,
      snapshot.commit_sha,
      parent.commit_sha,
    );
    return Response.json(diff, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleGetTurnSnapshotFile(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const snapshot = loadSnapshotForUser(request, userId);

    const url = new URL(request.url);
    const path = url.searchParams.get("path");
    if (!path) {
      throw new ValidationError("Query parameter 'path' is required");
    }

    const backend = getLocalBackend();
    if (!backend || typeof backend.readSnapshotFile !== "function") {
      throw new ValidationError("Execution backend is unavailable");
    }

    const buf = await backend.readSnapshotFile(
      snapshot.project_id,
      snapshot.commit_sha,
      path,
    );
    // Buffer is a Uint8Array subclass; pass as BodyInit.
    return new Response(new Uint8Array(buf), {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/octet-stream",
        "Content-Length": String(buf.length),
      },
    });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleRevertTurnSnapshot(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const snapshot = loadSnapshotForUser(request, userId);

    const body = (await request.json().catch(() => null)) as { paths?: unknown } | null;
    const paths = body?.paths;
    if (!Array.isArray(paths) || paths.length === 0) {
      throw new ValidationError("'paths' must be a non-empty array of strings");
    }
    for (const p of paths) {
      if (typeof p !== "string" || p.length === 0) {
        throw new ValidationError("'paths' must be a non-empty array of strings");
      }
    }

    if (!snapshot.parent_snapshot_id) {
      throw new ValidationError(
        "cannot revert the first snapshot — no parent state to restore from",
      );
    }
    const parent = getTurnSnapshotById(snapshot.parent_snapshot_id);
    if (!parent) {
      throw new ValidationError(
        "cannot revert snapshot — parent snapshot row missing",
      );
    }

    const backend = getLocalBackend();
    if (!backend || typeof backend.revertSnapshotPaths !== "function") {
      throw new ValidationError("Execution backend is unavailable");
    }

    const result = await backend.revertSnapshotPaths(
      snapshot.project_id,
      parent.commit_sha,
      paths as string[],
    );
    return Response.json(result, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
