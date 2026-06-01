import { authenticateRequest } from "@/lib/auth/auth.ts";
import { corsHeaders } from "@/lib/http/cors.ts";
import { getParams } from "@/lib/http/request.ts";
import { handleError, requireHumanSession, toUTC } from "@/routes/utils.ts";
import { NotFoundError } from "@/lib/utils/errors.ts";
import {
  listCompanionTokensByUser,
  getCompanionTokenById,
  revokeCompanionToken,
} from "@/db/queries/companion-tokens.ts";
import { getProjectById } from "@/db/queries/projects.ts";
import { getCompanionRegistry } from "@/lib/companion/registry.ts";
import type { CompanionTokenRow } from "@/db/types.ts";

/**
 * Companion-token management — the web-UI side of the local `zero` companion.
 * These are USER-scoped: a user manages every computer they've connected from
 * one place (Account → Companion), regardless of which project each is bound
 * to. Tokens are minted by the device-authorization flow (see
 * `routes/companion-device.ts`); these routes only list and revoke them.
 *
 * Responses expose only a masked prefix — the full secret is shown once, to the
 * CLI, when the device login is approved.
 *
 * A companion token must NOT be usable to manage companion tokens (that would
 * let a browser-scoped credential escalate). `requireHumanSession` rejects it;
 * the routes also live outside the `/api/companion/` allowlist so a companion
 * token can't reach them at all.
 */

function formatToken(row: CompanionTokenRow) {
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: getProjectById(row.project_id)?.name ?? null,
    name: row.name,
    tokenMasked: row.token_prefix,
    lastConnectedAt: row.last_connected_at ? toUTC(row.last_connected_at) : null,
    expiresAt: toUTC(row.expires_at),
    createdAt: toUTC(row.created_at),
  };
}

export async function handleListCompanionTokens(request: Request): Promise<Response> {
  try {
    const payload = await authenticateRequest(request);
    requireHumanSession(payload);

    const rows = listCompanionTokensByUser(payload.userId);
    return Response.json(
      { tokens: rows.map(formatToken) },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleRevokeCompanionToken(request: Request): Promise<Response> {
  try {
    const payload = await authenticateRequest(request);
    requireHumanSession(payload);
    const { tokenId } = getParams<{ tokenId: string }>(request);

    const row = getCompanionTokenById(tokenId);
    if (!row || row.user_id !== payload.userId) {
      throw new NotFoundError("Companion token not found");
    }
    const revoked = revokeCompanionToken(tokenId, payload.userId);
    if (!revoked) throw new NotFoundError("Companion token not found");

    // Drop any live companion tunnel for this user so the revoked computer
    // can't keep driving the browser until its socket happens to close.
    getCompanionRegistry().disconnect(payload.userId);

    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
