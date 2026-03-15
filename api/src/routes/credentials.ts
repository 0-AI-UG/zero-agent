import { corsHeaders } from "@/lib/cors.ts";
import { authenticateRequest } from "@/lib/auth.ts";
import { validateBody, createCredentialSchema, updateCredentialSchema } from "@/lib/validation.ts";
import { handleError, verifyProjectAccess } from "@/routes/utils.ts";
import { readFromS3, writeToS3, deleteFromS3 } from "@/lib/s3.ts";
import { insertFile, getFilesByFolder, deleteFile as deleteFileRecord, getFileByS3Key } from "@/db/queries/files.ts";
import { getFolderByPath, createFolder as createFolderRecord } from "@/db/queries/folders.ts";
import { log } from "@/lib/logger.ts";

const credLog = log.child({ module: "routes:credentials" });

function ensureCredentialsFolderExists(projectId: string) {
  const existing = getFolderByPath(projectId, "/credentials/");
  if (!existing) {
    createFolderRecord(projectId, "/credentials/", "credentials");
  }
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
  return extractHostname(siteUrl);
}

interface CredentialFile {
  type: "password" | "passkey";
  label: string;
  siteUrl: string;
  username?: string;
  password?: string;
  totpSecret?: string;
  backupCodes?: string[];
  // Passkey fields
  credentialId?: string;
  privateKey?: string;
  rpId?: string;
  userHandle?: string;
  signCount?: number;
  createdAt: string;
  updatedAt?: string;
}

function formatCredentialForList(filename: string, data: CredentialFile, fileId: string) {
  return {
    id: fileId,
    label: data.label,
    siteUrl: data.siteUrl,
    credType: data.type,
    hasTotp: !!data.totpSecret,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt ?? data.createdAt,
  };
}

export async function handleListCredentials(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId } = (request as Request & { params: { projectId: string } }).params;
    verifyProjectAccess(projectId, userId);

    const files = getFilesByFolder(projectId, "/credentials/");
    const credentials = [];

    for (const file of files) {
      try {
        const content = await readFromS3(file.s3_key);
        const data = JSON.parse(content) as CredentialFile;
        credentials.push(formatCredentialForList(file.filename, data, file.id));
      } catch {
        // Skip files that can't be parsed
      }
    }

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
    const now = new Date().toISOString();
    const domain = domainFromSiteUrl(data.siteUrl);

    const credFile: CredentialFile = {
      type: data.credType,
      label: data.label,
      siteUrl: data.siteUrl,
      createdAt: now,
      updatedAt: now,
    };

    if (data.credType === "password") {
      credFile.username = data.username;
      credFile.password = data.password;
      if (data.totpSecret) credFile.totpSecret = data.totpSecret;
      if (data.backupCodes?.length) credFile.backupCodes = data.backupCodes;
    }

    ensureCredentialsFolderExists(projectId);
    const filename = data.credType === "passkey" ? `${domain}.passkey.json` : `${domain}.json`;
    const s3Key = `projects/${projectId}/credentials/${filename}`;
    const content = JSON.stringify(credFile, null, 2);
    await writeToS3(s3Key, content);
    const fileRow = insertFile(projectId, s3Key, filename, "application/json", content.length, "/credentials/");

    credLog.info("credential created", { userId, projectId, label: data.label });

    return Response.json(
      { credential: formatCredentialForList(filename, credFile, fileRow.id) },
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

    // Find the file by ID (id is the file row id)
    const { getFileById } = await import("@/db/queries/files.ts");
    const fileRow = getFileById(id);
    if (!fileRow || fileRow.project_id !== projectId) {
      return Response.json({ error: "Credential not found" }, { status: 404, headers: corsHeaders });
    }

    // Read existing content
    const existingContent = await readFromS3(fileRow.s3_key);
    const existing = JSON.parse(existingContent) as CredentialFile;

    // Merge updates
    existing.label = data.label;
    existing.siteUrl = data.siteUrl;
    existing.updatedAt = new Date().toISOString();

    if (data.credType === "password") {
      if (data.username) existing.username = data.username;
      if (data.password) existing.password = data.password;
      if (data.totpSecret !== undefined) existing.totpSecret = data.totpSecret || undefined;
      if (data.backupCodes !== undefined) existing.backupCodes = data.backupCodes?.length ? data.backupCodes : undefined;
    }

    const content = JSON.stringify(existing, null, 2);
    await writeToS3(fileRow.s3_key, content);

    credLog.info("credential updated", { userId, projectId, credentialId: id });

    return Response.json(
      { credential: formatCredentialForList(fileRow.filename, existing, fileRow.id) },
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

    const { getFileById } = await import("@/db/queries/files.ts");
    const fileRow = getFileById(id);
    if (!fileRow || fileRow.project_id !== projectId) {
      return Response.json({ error: "Credential not found" }, { status: 404, headers: corsHeaders });
    }

    await deleteFromS3(fileRow.s3_key);
    deleteFileRecord(fileRow.id);

    credLog.info("credential deleted", { userId, projectId, credentialId: id });

    return Response.json(
      { success: true },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

