/**
 * Per-project email mailbox registry. Each enabled project keeps its own
 * IMAP IDLE connection and SMTP transport.
 *
 * Mailbox config is stored on the `projects` row (email_address,
 * email_password_enc, email_imap_*, email_smtp_*). Password is encrypted
 * with the credentials AES key.
 *
 * Admin-level `email_enabled` setting is a global feature gate — when off,
 * `isFeatureEnabled()` returns false and the registry refuses to start any
 * mailbox.
 */
import { getSetting } from "@/lib/settings.ts";
import { encrypt, decrypt } from "@/lib/auth/crypto.ts";
import { log } from "@/lib/utils/logger.ts";
import { ImapSmtpBackend } from "./backends/imap-smtp.ts";
import type { OutboundMessage, SendResult } from "./backend.ts";
import type { ParsedInbound } from "./parser.ts";
import {
  getProjectById,
  listEmailEnabledProjects,
} from "@/db/queries/projects.ts";
import type { ProjectRow } from "@/db/types.ts";

const mbLog = log.child({ module: "email/mailbox" });

const backends = new Map<string, ImapSmtpBackend>();
let inboundHandler: ((projectId: string, inbound: ParsedInbound) => Promise<void>) | null = null;

export function registerInboundHandler(handler: (projectId: string, inbound: ParsedInbound) => Promise<void>): void {
  inboundHandler = handler;
}

/** Admin-level feature gate. `email_enabled = "1"` enables the integration deployment-wide. */
export function isFeatureEnabled(): boolean {
  return getSetting("email_enabled") === "1";
}

export async function encryptMailboxPassword(plaintext: string): Promise<string> {
  return encrypt(plaintext);
}

export async function decryptMailboxPassword(enc: string): Promise<string> {
  return decrypt(enc);
}

function projectHasFullConfig(p: ProjectRow): boolean {
  return !!(
    p.email_address &&
    p.email_password_enc &&
    p.email_imap_host &&
    p.email_imap_port &&
    p.email_smtp_host &&
    p.email_smtp_port
  );
}

/** Start IMAP IDLE for a single project (no-op if backend already running). */
export async function startProjectMailbox(projectId: string): Promise<void> {
  if (!isFeatureEnabled()) {
    mbLog.info("feature gate off — refusing to start", { projectId });
    return;
  }
  if (backends.has(projectId)) return;
  const project = getProjectById(projectId);
  if (!project || project.email_enabled !== 1 || !projectHasFullConfig(project)) {
    mbLog.info("project not configured — skipping start", { projectId });
    return;
  }
  const pass = await decrypt(project.email_password_enc!);
  const backend = new ImapSmtpBackend({
    user: project.email_address!,
    pass,
    fromName: project.email_from_name || project.name,
    imap: { host: project.email_imap_host!, port: project.email_imap_port!, secure: (project.email_imap_secure as "tls" | "starttls") || "tls" },
    smtp: { host: project.email_smtp_host!, port: project.email_smtp_port!, secure: (project.email_smtp_secure as "tls" | "starttls") || "tls" },
  });
  backends.set(projectId, backend);
  await backend.startWatching(async (inbound) => {
    if (!inboundHandler) {
      mbLog.warn("inbound received but no handler registered", { projectId });
      return;
    }
    try {
      await inboundHandler(projectId, inbound);
    } catch (err) {
      mbLog.error("inbound handler failed", err, { projectId });
    }
  });
  mbLog.info("project mailbox started", { projectId, address: project.email_address });
}

export async function stopProjectMailbox(projectId: string): Promise<void> {
  const backend = backends.get(projectId);
  if (!backend) return;
  try { await backend.close(); } catch { /* ignore */ }
  backends.delete(projectId);
  mbLog.info("project mailbox stopped", { projectId });
}

export async function restartProjectMailbox(projectId: string): Promise<void> {
  await stopProjectMailbox(projectId);
  await startProjectMailbox(projectId);
}

/** Boot helper: start mailboxes for every enabled project. */
export async function startAllMailboxes(): Promise<void> {
  if (!isFeatureEnabled()) {
    mbLog.info("feature gate off — not starting any project mailboxes");
    return;
  }
  for (const p of listEmailEnabledProjects()) {
    try {
      await startProjectMailbox(p.id);
    } catch (err) {
      mbLog.error("failed to start project mailbox", err, { projectId: p.id });
    }
  }
}

export async function stopAllMailboxes(): Promise<void> {
  for (const id of [...backends.keys()]) {
    await stopProjectMailbox(id);
  }
}

/** Send an outbound message via the project's SMTP transport. */
export async function sendForProject(projectId: string, msg: OutboundMessage): Promise<SendResult> {
  let backend = backends.get(projectId);
  if (!backend) {
    // Spin it up on demand (e.g. cold outreach after a fresh server start).
    await startProjectMailbox(projectId);
    backend = backends.get(projectId);
  }
  if (!backend) return { ok: false, messageId: msg.messageId, error: "Project mailbox not configured" };
  return backend.send(msg);
}

export function isProjectMailboxReady(projectId: string): boolean {
  return backends.get(projectId)?.isReady() ?? false;
}
