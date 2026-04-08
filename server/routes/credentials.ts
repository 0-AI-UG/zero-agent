import { corsHeaders } from "@/lib/cors.ts";
import { authenticateRequest } from "@/lib/auth.ts";
import { validateBody, createCredentialSchema, updateCredentialSchema } from "@/lib/validation.ts";
import { handleError, verifyProjectAccess } from "@/routes/utils.ts";
import { encrypt } from "@/lib/crypto.ts";
import {
  insertCredential,
  getCredentialsByProject,
  getCredentialById,
  updateCredential,
  deleteCredential,
} from "@/db/queries/credentials.ts";
import { log } from "@/lib/logger.ts";

const credLog = log.child({ module: "routes:credentials" });

const TWO_PART_TLDS = new Set([
  "co.uk", "co.jp", "co.kr", "co.nz", "co.za", "co.in", "co.il",
  "com.au", "com.br", "com.cn", "com.mx", "com.tw", "com.hk", "com.sg", "com.ar",
  "org.uk", "org.au", "net.au", "ac.uk",
]);

function getBaseDomain(hostname: string): string {
  const parts = hostname.split(".");
  if (parts.length <= 2) return hostname;
  const lastTwo = parts.slice(-2).join(".");
  if (TWO_PART_TLDS.has(lastTwo)) return parts.slice(-3).join(".");
  return parts.slice(-2).join(".");
}

function extractHostname(url: string): string {
  try {
    const normalized = url.includes("://") ? url : `https://${url}`;
    return new URL(normalized).hostname.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

function domainFromSiteUrl(siteUrl: string): string {
  return getBaseDomain(extractHostname(siteUrl));
}

function formatCredentialForList(row: {
  id: string;
  label: string;
  site_url: string;
  cred_type: string;
  totp_secret_enc: string | null;
  created_at: string;
  updated_at: string;
}) {
  return {
    id: row.id,
    label: row.label,
    siteUrl: row.site_url,
    credType: row.cred_type,
    hasTotp: !!row.totp_secret_enc,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function handleListCredentials(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId } = (request as Request & { params: { projectId: string } }).params;
    verifyProjectAccess(projectId, userId);

    const rows = getCredentialsByProject(projectId);
    const credentials = rows.map((row) => formatCredentialForList(row));

    return Response.json(
      { credentials },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleCreateCredential(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId } = (request as Request & { params: { projectId: string } }).params;
    verifyProjectAccess(projectId, userId);

    const data = await validateBody(request, createCredentialSchema);
    const domain = domainFromSiteUrl(data.siteUrl);

    const fields: Parameters<typeof insertCredential>[1] = {
      credType: data.credType,
      label: data.label,
      siteUrl: data.siteUrl,
      domain,
    };

    if (data.credType === "password") {
      fields.username = data.username;
      fields.passwordEnc = await encrypt(data.password);
      if (data.totpSecret) fields.totpSecretEnc = await encrypt(data.totpSecret);
      if (data.backupCodes?.length) fields.backupCodesEnc = await encrypt(JSON.stringify(data.backupCodes));
    }

    const row = insertCredential(projectId, fields);

    credLog.info("credential created", { userId, projectId, label: data.label });

    return Response.json(
      { credential: formatCredentialForList(row) },
      { status: 201, headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleUpdateCredential(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId, id } = (request as Request & { params: { projectId: string; id: string } }).params;
    verifyProjectAccess(projectId, userId);

    const data = await validateBody(request, updateCredentialSchema);

    const existing = getCredentialById(id);
    if (!existing || existing.project_id !== projectId) {
      return Response.json({ error: "Credential not found" }, { status: 404, headers: corsHeaders });
    }

    const fields: Parameters<typeof updateCredential>[1] = {
      label: data.label,
      siteUrl: data.siteUrl,
      domain: domainFromSiteUrl(data.siteUrl),
    };

    if (data.credType === "password") {
      if (data.username) fields.username = data.username;
      if (data.password) fields.passwordEnc = await encrypt(data.password);
      if (data.totpSecret !== undefined) {
        fields.totpSecretEnc = data.totpSecret ? await encrypt(data.totpSecret) : null;
      }
      if (data.backupCodes !== undefined) {
        fields.backupCodesEnc = data.backupCodes?.length
          ? await encrypt(JSON.stringify(data.backupCodes))
          : null;
      }
    }

    const row = updateCredential(id, fields);
    if (!row) {
      return Response.json({ error: "Credential not found" }, { status: 404, headers: corsHeaders });
    }

    credLog.info("credential updated", { userId, projectId, credentialId: id });

    return Response.json(
      { credential: formatCredentialForList(row) },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleDeleteCredential(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId, id } = (request as Request & { params: { projectId: string; id: string } }).params;
    verifyProjectAccess(projectId, userId);

    const existing = getCredentialById(id);
    if (!existing || existing.project_id !== projectId) {
      return Response.json({ error: "Credential not found" }, { status: 404, headers: corsHeaders });
    }

    deleteCredential(id);

    credLog.info("credential deleted", { userId, projectId, credentialId: id });

    return Response.json(
      { success: true },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}
