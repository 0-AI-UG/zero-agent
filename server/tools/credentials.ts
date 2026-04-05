import { z } from "zod";
import { tool } from "ai";
import type { Tool } from "ai";
import { log } from "@/lib/logger.ts";
import { encrypt, decrypt } from "@/lib/crypto.ts";
import {
  insertCredential,
  getCredentialsByDomain,
  getCredentialsByLabel,
  getCredentialByDomainAndType,
  updateCredential,
  updateSignCount,
} from "@/db/queries/credentials.ts";
import { nanoid } from "nanoid";

const credLog = log.child({ module: "tool:credentials" });

function extractHostname(url: string): string {
  try {
    const normalized = url.includes("://") ? url : `https://${url}`;
    return new URL(normalized).hostname.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

const TWO_PART_TLDS = new Set([
  "co.uk", "co.jp", "co.kr", "co.nz", "co.za", "co.in", "co.il",
  "com.au", "com.br", "com.cn", "com.mx", "com.tw", "com.hk", "com.sg", "com.ar",
  "org.uk", "org.au", "net.au", "ac.uk",
]);

export function getBaseDomain(hostname: string): string {
  const parts = hostname.split(".");
  if (parts.length <= 2) return hostname;
  const lastTwo = parts.slice(-2).join(".");
  if (TWO_PART_TLDS.has(lastTwo)) return parts.slice(-3).join(".");
  return parts.slice(-2).join(".");
}

function domainFromUrl(url: string): string {
  return getBaseDomain(extractHostname(url));
}

// Ephemeral holder: full (unredacted) output from the last loadAccount call.
// Used by toModelOutput so the model can fill forms while the persisted output stays redacted.
let lastLoadResult: any = null;

export function createCredentialTools(projectId: string, userId?: string): Record<string, Tool<any, any>> {
  const tools: Record<string, Tool<any, any>> = {};

  tools.saveAccount = tool({
    description:
      "Save login credentials (password or passkey) for a website. For passkeys, exports from the virtual authenticator automatically. For passwords, provide username and password.",
    inputSchema: z.discriminatedUnion("credType", [
      z.object({
        credType: z.literal("password"),
        siteUrl: z.string().describe("The website URL"),
        label: z.string().describe("A label for this account (e.g. 'Work Gmail')"),
        username: z.string().describe("Username or email"),
        password: z.string().describe("The password"),
        totpSecret: z.string().optional().describe("TOTP base32 secret for authenticator app"),
        backupCodes: z.array(z.string()).optional().describe("Backup/recovery codes"),
      }),
      z.object({
        credType: z.literal("passkey"),
        siteUrl: z.string().describe("The website URL where the passkey was registered"),
        label: z.string().describe("A label for this credential"),
      }),
    ]),
    execute: async (input) => {
      const domain = domainFromUrl(input.siteUrl);

      if (input.credType === "password") {
        const passwordEnc = await encrypt(input.password);
        const totpSecretEnc = input.totpSecret ? await encrypt(input.totpSecret) : null;
        const backupCodesEnc = input.backupCodes?.length
          ? await encrypt(JSON.stringify(input.backupCodes))
          : null;

        // Upsert: update if same domain + type exists
        const existing = getCredentialByDomainAndType(projectId, domain, "password");
        if (existing) {
          updateCredential(existing.id, {
            label: input.label,
            siteUrl: input.siteUrl,
            username: input.username,
            passwordEnc,
            totpSecretEnc,
            backupCodesEnc,
          });
          credLog.info("password credential updated", { projectId, domain });
          return { saved: true, updated: true };
        }

        insertCredential(projectId, {
          credType: "password",
          label: input.label,
          siteUrl: input.siteUrl,
          domain,
          username: input.username,
          passwordEnc,
          totpSecretEnc,
          backupCodesEnc,
        });

        credLog.info("password credential saved", { projectId, domain });
        return { saved: true };
      }

      // Passkey type — requires WebAuthn which is not supported in server-only mode
      return { saved: false, error: "Passkey operations are not supported in server-only mode." };
    },
  });

  tools.loadAccount = tool({
    description:
      "Load saved account credentials for a website. For passkeys, loads into the virtual authenticator. For passwords, returns username, password, and TOTP secret. Search by site URL or label. Credential secrets are provided for form-filling only — NEVER repeat them in your response text.",
    inputSchema: z.object({
      siteUrl: z.string().optional().describe("The website URL to find credentials for"),
      label: z.string().optional().describe("Search by account label"),
    }),
    execute: async ({ siteUrl, label }) => {
      if (!siteUrl && !label) {
        return { found: false, error: "Provide siteUrl or label to search." };
      }

      let rows = siteUrl
        ? getCredentialsByDomain(projectId, domainFromUrl(siteUrl))
        : [];

      if (rows.length === 0 && label) {
        rows = getCredentialsByLabel(projectId, label);
      }

      if (rows.length === 0) {
        return { found: false };
      }

      // Build both a redacted version (stored/displayed) and a full version (model-only)
      const redacted = [];
      const full = [];

      for (const row of rows) {
        if (row.cred_type === "password") {
          const password = row.password_enc ? await decrypt(row.password_enc) : null;
          const totpSecret = row.totp_secret_enc ? await decrypt(row.totp_secret_enc) : null;

          redacted.push({
            type: "password" as const,
            label: row.label,
            siteUrl: row.site_url,
            username: row.username,
            hasPassword: !!password,
            hasTotp: !!totpSecret,
            hasBackupCodes: !!row.backup_codes_enc,
          });

          full.push({
            type: "password" as const,
            label: row.label,
            siteUrl: row.site_url,
            username: row.username,
            password,
            totpSecret,
            hasBackupCodes: !!row.backup_codes_enc,
          });
        } else {
          // Passkey loading not supported in server-only mode
          const entry = {
            type: "passkey" as const,
            label: row.label,
            siteUrl: row.site_url,
            loaded: false,
            error: "Passkey operations are not supported in server-only mode.",
          };
          redacted.push(entry);
          full.push(entry);
        }
      }

      // Store full credentials for toModelOutput, return redacted for persistence/UI
      lastLoadResult = { found: true, credentials: full };
      return { found: true, credentials: redacted };
    },
    toModelOutput({ output }: { output: any }) {
      // Give the model the full (unredacted) credentials so it can fill forms,
      // while the stored output (from execute) stays redacted.
      if (lastLoadResult) {
        const result = lastLoadResult;
        lastLoadResult = null;
        return { type: "json" as const, value: result as any };
      }
      return { type: "json" as const, value: (output ?? null) as any };
    },
  });

  return tools;
}
