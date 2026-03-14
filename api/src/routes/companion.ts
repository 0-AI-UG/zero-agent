import { corsHeaders } from "@/lib/cors.ts";
import { authenticateRequest } from "@/lib/auth.ts";
import { validateBody, createCompanionTokenSchema } from "@/lib/validation.ts";
import { handleError } from "@/routes/utils.ts";
import { verifyProjectAccess } from "@/routes/utils.ts";
import {
  insertCompanionToken,
  getCompanionTokensByProject,
  deleteCompanionToken,
} from "@/db/queries/companion-tokens.ts";
import { browserBridge } from "@/lib/browser/bridge.ts";
import { nanoid } from "nanoid";
import { log } from "@/lib/logger.ts";
import type { CompanionTokenRow } from "@/db/types.ts";

const companionLog = log.child({ module: "routes:companion" });

function formatToken(row: CompanionTokenRow) {
  return {
    id: row.id,
    name: row.name,
    tokenPreview: row.token.slice(0, 8) + "..." + row.token.slice(-4),
    lastConnectedAt: row.last_connected_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

export async function handleListCompanionTokens(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId } = (request as Request & { params: { projectId: string } }).params;
    verifyProjectAccess(projectId, userId);
    const rows = getCompanionTokensByProject(projectId);
    return Response.json(
      { tokens: rows.map(formatToken) },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleCreateCompanionToken(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId } = (request as Request & { params: { projectId: string } }).params;
    verifyProjectAccess(projectId, userId);
    const { name } = await validateBody(request, createCompanionTokenSchema);

    const token = nanoid(32);
    const row = insertCompanionToken(userId, projectId, { token, name });

    companionLog.info("companion token created", { userId, projectId, name });

    return Response.json(
      {
        token: {
          ...formatToken(row),
          // Return full token only on creation
          token: row.token,
        },
      },
      { status: 201, headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleDeleteCompanionToken(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId, id } = (request as Request & { params: { projectId: string; id: string } }).params;
    verifyProjectAccess(projectId, userId);

    deleteCompanionToken(id, userId);
    companionLog.info("companion token deleted", { userId, projectId, tokenId: id });

    return Response.json(
      { success: true },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleCompanionStatus(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId } = (request as Request & { params: { projectId: string } }).params;
    verifyProjectAccess(projectId, userId);
    const status = browserBridge.getStatus(userId, projectId);

    companionLog.debug("companion status check", { userId, projectId, connected: status.connected });

    return Response.json(
      { status },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}
