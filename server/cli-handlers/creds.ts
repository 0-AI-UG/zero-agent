/**
 * Credentials handlers - list/get/set/remove. Wraps the existing
 * server/db/queries/credentials.ts and server/lib/crypto.ts.
 *
 * SECURITY:
 *   - The decrypted secret value is included only in the response body
 *     of /creds/get (under data.value). It is NEVER logged or echoed
 *     anywhere else on the server side.
 *   - The CLI prints `value` to stdout only and nothing else.
 *   - The runner proxy forwards bytes verbatim and does not log bodies.
 *   - On a "not found" lookup, /creds/get returns a 404 so the CLI
 *     exits non-zero, preventing silent empty interpolation.
 */
import type { z } from "zod";
import { encrypt, decrypt } from "@/lib/crypto.ts";
import {
  insertCredential,
  getCredentialsByProject,
  getCredentialsByDomain,
  getCredentialsByLabel,
  getCredentialByDomainAndType,
  updateCredential,
  deleteCredential,
  getCredentialById,
} from "@/db/queries/credentials.ts";
import type { CliContext } from "./context.ts";
import { ok, fail } from "./response.ts";
import type {
  CredsGetInput,
  CredsSetInput,
  CredsRemoveInput,
} from "zero/schemas";

const TWO_PART_TLDS = new Set([
  "co.uk", "co.jp", "co.kr", "co.nz", "co.za", "co.in", "co.il",
  "com.au", "com.br", "com.cn", "com.mx", "com.tw", "com.hk", "com.sg", "com.ar",
  "org.uk", "org.au", "net.au", "ac.uk",
]);

function extractHostname(url: string): string {
  try {
    const normalized = url.includes("://") ? url : `https://${url}`;
    return new URL(normalized).hostname.toLowerCase();
  } catch { return url.toLowerCase(); }
}

function getBaseDomain(hostname: string): string {
  const parts = hostname.split(".");
  if (parts.length <= 2) return hostname;
  const lastTwo = parts.slice(-2).join(".");
  if (TWO_PART_TLDS.has(lastTwo)) return parts.slice(-3).join(".");
  return parts.slice(-2).join(".");
}

function domainFromUrl(url: string): string {
  return getBaseDomain(extractHostname(url));
}

/** Public (non-secret) credential metadata. */
function summarize(row: any) {
  return {
    id: row.id,
    label: row.label,
    type: row.cred_type,
    siteUrl: row.site_url,
    domain: row.domain,
    username: row.username ?? undefined,
    hasPassword: !!row.password_enc,
    hasTotp: !!row.totp_secret_enc,
    hasBackupCodes: !!row.backup_codes_enc,
  };
}

export async function handleCredsList(ctx: CliContext): Promise<Response> {
  const rows = getCredentialsByProject(ctx.projectId);
  return ok({ credentials: rows.map(summarize) });
}

/**
 * Resolve a single credential by label/domain/id and return the decrypted
 * secret in `data.value`.
 */
export async function handleCredsGet(
  ctx: CliContext,
  input: z.infer<typeof CredsGetInput>,
): Promise<Response> {
  const field = input.field ?? "password";

  let row: any = null;
  if (input.id) {
    const r = getCredentialById(input.id);
    if (r && r.project_id === ctx.projectId) row = r;
  } else if (input.label) {
    const rows = getCredentialsByLabel(ctx.projectId, input.label);
    row = rows[0] ?? null;
  } else if (input.siteUrl) {
    const rows = getCredentialsByDomain(ctx.projectId, domainFromUrl(input.siteUrl));
    row = rows[0] ?? null;
  }

  if (!row) return fail("not_found", "credential not found", 404);

  if (field === "username") {
    if (!row.username) return fail("not_found", "no username on this credential", 404);
    return ok({ value: row.username, field });
  }
  if (field === "password") {
    if (!row.password_enc) return fail("not_found", "no password on this credential", 404);
    const value = await decrypt(row.password_enc);
    return ok({ value, field });
  }
  if (field === "totp") {
    if (!row.totp_secret_enc) return fail("not_found", "no totp on this credential", 404);
    const value = await decrypt(row.totp_secret_enc);
    return ok({ value, field });
  }
  return fail("invalid", `unknown field "${field}"`);
}

export async function handleCredsSet(
  ctx: CliContext,
  input: z.infer<typeof CredsSetInput>,
): Promise<Response> {
  const domain = domainFromUrl(input.siteUrl);
  const passwordEnc = await encrypt(input.password);
  const totpSecretEnc = input.totpSecret ? await encrypt(input.totpSecret) : null;

  const existing = getCredentialByDomainAndType(ctx.projectId, domain, "password");
  if (existing) {
    updateCredential(existing.id, {
      label: input.label,
      siteUrl: input.siteUrl,
      username: input.username,
      passwordEnc,
      totpSecretEnc,
      backupCodesEnc: null,
    });
    return ok({ saved: true, updated: true, id: existing.id });
  }

  const row = insertCredential(ctx.projectId, {
    credType: "password",
    label: input.label,
    siteUrl: input.siteUrl,
    domain,
    username: input.username,
    passwordEnc,
    totpSecretEnc,
    backupCodesEnc: null,
  });
  return ok({ saved: true, updated: false, id: (row as any).id });
}

export async function handleCredsRemove(
  ctx: CliContext,
  input: z.infer<typeof CredsRemoveInput>,
): Promise<Response> {
  let id = input.id;
  if (!id && input.label) {
    const rows = getCredentialsByLabel(ctx.projectId, input.label);
    id = rows[0]?.id;
  }
  if (!id) return fail("invalid", "provide id or label");
  const row = getCredentialById(id);
  if (!row || row.project_id !== ctx.projectId) return fail("not_found", "credential not found", 404);
  deleteCredential(id);
  return ok({ removed: true, id });
}
