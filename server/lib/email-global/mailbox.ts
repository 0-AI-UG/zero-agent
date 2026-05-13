/**
 * Email mailbox singleton. Reads settings, constructs an `ImapSmtpBackend`,
 * exposes send/start/stop, and reflects the latest password encryption.
 *
 * Settings keys:
 *   email_address              user@domain.com
 *   email_password_enc         encrypted via lib/auth/crypto
 *   email_from_name            "Zero Agent"
 *   email_imap_host / port / secure
 *   email_smtp_host / port / secure
 *   email_autoconfig_status    "ok" | "manual" | "failed:<reason>"
 */
import { getSetting, setSetting } from "@/lib/settings.ts";
import { encrypt, decrypt } from "@/lib/auth/crypto.ts";
import { log } from "@/lib/utils/logger.ts";
import { ImapSmtpBackend, type ImapSmtpConfig } from "./backends/imap-smtp.ts";
import type { EmailBackend, OutboundMessage, SendResult } from "./backend.ts";
import type { ParsedInbound } from "./parser.ts";
import type { SecurityMode } from "./autoconfig.ts";

const mbLog = log.child({ module: "email/mailbox" });

let backend: EmailBackend | null = null;
let inboundHandler: ((inbound: ParsedInbound) => Promise<void>) | null = null;

export function registerInboundHandler(handler: (inbound: ParsedInbound) => Promise<void>): void {
  inboundHandler = handler;
}

export function getMailboxDomain(): string | null {
  const addr = getSetting("email_address");
  if (!addr) return null;
  const at = addr.lastIndexOf("@");
  if (at <= 0) return null;
  return addr.slice(at + 1).toLowerCase();
}

export function getMailboxAddress(): string | null {
  return getSetting("email_address");
}

export function getFromName(): string {
  return getSetting("email_from_name") || "Zero Agent";
}

export function isEmailConfigured(): boolean {
  return !!getSetting("email_address") && !!getSetting("email_password_enc");
}

export async function setEmailPassword(plaintext: string): Promise<void> {
  const enc = await encrypt(plaintext);
  setSetting("email_password_enc", enc);
}

async function loadConfig(): Promise<ImapSmtpConfig | null> {
  const user = getSetting("email_address");
  const passEnc = getSetting("email_password_enc");
  const imapHost = getSetting("email_imap_host");
  const imapPort = Number(getSetting("email_imap_port") || "0");
  const imapSecure = (getSetting("email_imap_secure") || "tls") as SecurityMode;
  const smtpHost = getSetting("email_smtp_host");
  const smtpPort = Number(getSetting("email_smtp_port") || "0");
  const smtpSecure = (getSetting("email_smtp_secure") || "tls") as SecurityMode;
  if (!user || !passEnc || !imapHost || !imapPort || !smtpHost || !smtpPort) return null;
  const pass = await decrypt(passEnc);
  return {
    user,
    pass,
    fromName: getFromName(),
    imap: { host: imapHost, port: imapPort, secure: imapSecure },
    smtp: { host: smtpHost, port: smtpPort, secure: smtpSecure },
  };
}

export async function startEmailMailbox(): Promise<void> {
  if (backend) return;
  const cfg = await loadConfig();
  if (!cfg) {
    mbLog.info("email not configured — skipping start");
    return;
  }
  backend = new ImapSmtpBackend(cfg);
  await backend.startWatching(async (inbound) => {
    if (!inboundHandler) {
      mbLog.warn("inbound received but no handler registered");
      return;
    }
    try {
      await inboundHandler(inbound);
    } catch (err) {
      mbLog.error("inbound handler failed", err);
    }
  });
  mbLog.info("email mailbox started", { host: cfg.imap.host });
}

export async function restartEmailMailbox(): Promise<void> {
  if (backend) {
    try { await backend.close(); } catch { /* ignore */ }
    backend = null;
  }
  await startEmailMailbox();
}

export async function stopEmailMailbox(): Promise<void> {
  if (!backend) return;
  await backend.close();
  backend = null;
}

export async function sendEmail(msg: OutboundMessage): Promise<SendResult> {
  if (!backend) {
    // Allow sends even if IDLE isn't watching yet — re-init lazily.
    await startEmailMailbox();
  }
  if (!backend) return { ok: false, messageId: msg.messageId, error: "Email not configured" };
  return backend.send(msg);
}

export function isMailboxReady(): boolean {
  return !!backend && backend.isReady();
}
