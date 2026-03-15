import { z } from "zod";
import { tool } from "ai";
import type { Tool } from "ai";
import { log } from "@/lib/logger.ts";
import { browserBridge } from "@/lib/browser/bridge.ts";
import { readFromS3, writeToS3 } from "@/lib/s3.ts";
import { insertFile } from "@/db/queries/files.ts";
import { getFolderByPath, createFolder as createFolderRecord } from "@/db/queries/folders.ts";
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

function ensureCredentialsFolderExists(projectId: string) {
  const existing = getFolderByPath(projectId, "/credentials/");
  if (!existing) {
    createFolderRecord(projectId, "/credentials/", "credentials");
  }
}

async function writePasskeyFile(
  projectId: string,
  rpId: string,
  data: Record<string, unknown>,
): Promise<void> {
  ensureCredentialsFolderExists(projectId);
  const filename = `${rpId}.passkey.json`;
  const s3Key = `projects/${projectId}/credentials/${filename}`;
  const content = JSON.stringify(data, null, 2);
  await writeToS3(s3Key, content);
  insertFile(projectId, s3Key, filename, "application/json", content.length, "/credentials/");
}

async function readPasskeyFile(
  projectId: string,
  siteUrl: string,
): Promise<Record<string, unknown> | null> {
  const hostname = extractHostname(siteUrl);
  const baseDomain = getBaseDomain(hostname);

  // Try exact hostname first, then base domain
  for (const domain of [hostname, baseDomain]) {
    try {
      const s3Key = `projects/${projectId}/credentials/${domain}.passkey.json`;
      const content = await readFromS3(s3Key);
      return JSON.parse(content);
    } catch {
      // Not found, try next
    }
  }
  return null;
}

export function createCredentialTools(projectId: string, userId?: string): Record<string, Tool<any, any>> {
  const tools: Record<string, Tool<any, any>> = {};

  // Passkey tools — only available when userId is provided (companion needed)
  if (userId) {
    tools.savePasskeyCredential = tool({
      description:
        "After a passkey has been registered on a website, export and save the credential from the virtual authenticator.",
      inputSchema: z.object({
        siteUrl: z.string().describe("The website URL where the passkey was registered"),
        label: z.string().describe("A label for this credential"),
      }),
      execute: async ({ siteUrl, label }) => {
        const authenticatorId = await browserBridge.ensureAuthenticator(userId, projectId);

        const result = await browserBridge.sendWebAuthnCommand(userId, projectId, {
          type: "getCredentials",
          commandId: nanoid(),
          authenticatorId,
        }) as { credentials: Array<{ credentialId: string; rpId: string; privateKey: string; userHandle: string; signCount: number }> };

        if (!result.credentials || result.credentials.length === 0) {
          return { saved: false, error: "No credentials found on the virtual authenticator. Make sure you completed the passkey registration on the website." };
        }

        const cred = result.credentials[0]!;

        const passkeyData = {
          type: "passkey",
          label,
          siteUrl,
          credentialId: cred.credentialId,
          privateKey: cred.privateKey,
          rpId: cred.rpId,
          userHandle: cred.userHandle,
          signCount: cred.signCount,
          createdAt: new Date().toISOString(),
        };

        await writePasskeyFile(projectId, cred.rpId, passkeyData);

        credLog.info("passkey credential saved", { projectId, siteUrl, rpId: cred.rpId });
        return { saved: true };
      },
    });

    tools.loadPasskey = tool({
      description:
        "Load a saved passkey into the companion browser's virtual authenticator so you can sign in with it. Call this before clicking 'Sign in with passkey' on a website.",
      inputSchema: z.object({
        siteUrl: z.string().describe("The URL of the site to sign into with passkey"),
      }),
      execute: async ({ siteUrl }) => {
        const passkey = await readPasskeyFile(projectId, siteUrl);
        if (!passkey || passkey.type !== "passkey") {
          return { loaded: false, error: "No passkey credential found for this site." };
        }

        const authenticatorId = await browserBridge.ensureAuthenticator(userId, projectId);

        await browserBridge.sendWebAuthnCommand(userId, projectId, {
          type: "addCredential",
          commandId: nanoid(),
          authenticatorId,
          credential: {
            credentialId: passkey.credentialId as string,
            rpId: passkey.rpId as string,
            privateKey: passkey.privateKey as string,
            userHandle: passkey.userHandle as string,
            signCount: (passkey.signCount as number) ?? 0,
          },
        });

        // Increment signCount in the file
        const newSignCount = ((passkey.signCount as number) ?? 0) + 1;
        passkey.signCount = newSignCount;
        await writePasskeyFile(projectId, passkey.rpId as string, passkey);

        credLog.info("passkey loaded", { projectId, siteUrl });
        return { loaded: true, rpId: passkey.rpId };
      },
    });
  }

  return tools;
}
