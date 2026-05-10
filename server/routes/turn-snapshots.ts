/**
 * Routes for per-turn host-fs git snapshots (diff, file read, revert).
 *
 * Auth: `authenticateRequest` + `verifyProjectAccess` against the project
 * referenced by the snapshot row. The snapshot id alone is enough to look
 * up the project — clients pass it back from the WS `turn.diff.ready`
 * envelope.
 */
import { corsHeaders } from "@/lib/http/cors.ts";
import { authenticateRequest } from "@/lib/auth/auth.ts";
import { getParams } from "@/lib/http/request.ts";
import { handleError, verifyProjectAccess } from "@/routes/utils.ts";
import { ValidationError, NotFoundError } from "@/lib/utils/errors.ts";
import { getTurnSnapshotById } from "@/db/queries/turn-snapshots.ts";
import {
  getSnapshotDiff,
  readSnapshotFile,
  revertSnapshotPaths,
} from "@/lib/snapshots/snapshot-service.ts";
import { syncProjectPath } from "@/lib/projects/watcher.ts";

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
      return Response.json([], { headers: corsHeaders });
    }

    const diff = await getSnapshotDiff(
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

    const buf = await readSnapshotFile(
      snapshot.project_id,
      snapshot.commit_sha,
      path,
    );
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

    const result = await revertSnapshotPaths(
      snapshot.project_id,
      parent.commit_sha,
      paths as string[],
    );

    // Sync the DB for every path we attempted — `fs.watch` is best-effort
    // (events can be coalesced or dropped, and the watcher may not even be
    // attached). Do it eagerly so the file list reflects the revert
    // immediately, regardless of watcher state.
    await Promise.all(
      (paths as string[]).map((p) =>
        syncProjectPath(snapshot.project_id, p).catch(() => undefined),
      ),
    );

    return Response.json(result, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
