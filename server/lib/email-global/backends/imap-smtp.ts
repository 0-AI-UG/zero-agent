/**
 * IMAP IDLE inbound + SMTP outbound backend.
 *
 * Reconnect-on-drop loop, lazy auth from settings. One inbox; demuxing to
 * projects happens upstream in the email ChatProvider router.
 */
import { ImapFlow } from "imapflow";
import nodemailer, { type Transporter } from "nodemailer";
import { log } from "@/lib/utils/logger.ts";
import { parseRfc822, type ParsedInbound } from "../parser.ts";
import type { EmailBackend, OutboundMessage, SendResult } from "../backend.ts";
import type { SecurityMode } from "../autoconfig.ts";

const bLog = log.child({ module: "email/imap-smtp" });

export interface ImapSmtpConfig {
  user: string;
  pass: string;
  fromName: string;
  imap: { host: string; port: number; secure: SecurityMode };
  smtp: { host: string; port: number; secure: SecurityMode };
}

export class ImapSmtpBackend implements EmailBackend {
  private client: ImapFlow | null = null;
  private transporter: Transporter;
  private watching = false;
  private ready = false;
  private stopped = false;
  private reconnectDelay = 2000;

  constructor(private cfg: ImapSmtpConfig) {
    this.transporter = nodemailer.createTransport({
      host: cfg.smtp.host,
      port: cfg.smtp.port,
      secure: cfg.smtp.secure === "tls",
      auth: { user: cfg.user, pass: cfg.pass },
      requireTLS: cfg.smtp.secure === "starttls",
    });
  }

  isReady(): boolean {
    return this.ready;
  }

  async send(msg: OutboundMessage): Promise<SendResult> {
    try {
      const info = await this.transporter.sendMail({
        from: msg.from,
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        html: msg.html ?? undefined,
        replyTo: msg.replyTo,
        inReplyTo: msg.inReplyTo ?? undefined,
        references: msg.references ?? undefined,
        messageId: msg.messageId,
        attachments: msg.attachments?.map((a) => ({
          filename: a.filename,
          content: a.content,
          contentType: a.contentType,
        })),
      });
      return { ok: true, messageId: info.messageId ?? msg.messageId };
    } catch (err) {
      bLog.error("smtp send failed", err);
      return { ok: false, messageId: msg.messageId, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async startWatching(onMessage: (inbound: ParsedInbound, raw: { uid: number }) => Promise<void>): Promise<void> {
    if (this.watching) return;
    this.watching = true;
    this.stopped = false;
    void this.watchLoop(onMessage);
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.watching = false;
    this.ready = false;
    try {
      await this.client?.logout();
    } catch {
      /* ignore */
    }
    this.client = null;
    this.transporter.close();
  }

  private async watchLoop(onMessage: (inbound: ParsedInbound, raw: { uid: number }) => Promise<void>): Promise<void> {
    while (!this.stopped) {
      try {
        const client = new ImapFlow({
          host: this.cfg.imap.host,
          port: this.cfg.imap.port,
          secure: this.cfg.imap.secure === "tls",
          auth: { user: this.cfg.user, pass: this.cfg.pass },
          logger: false,
        });
        this.client = client;
        await client.connect();
        const lock = await client.getMailboxLock("INBOX");
        this.ready = true;
        this.reconnectDelay = 2000;
        bLog.info("connected to inbox", { host: this.cfg.imap.host });

        try {
          // Initial sweep: any UNSEEN messages we may have missed during downtime.
          await this.processUnseen(client, onMessage);

          // Live tail: every IDLE expire we re-check UNSEEN. imapflow drives
          // IDLE under the hood whenever you `await mailbox.idle()`.
          client.on("exists", () => {
            void this.processUnseen(client, onMessage).catch((err) => bLog.error("exists handler failed", err));
          });

          // Keep the connection alive — imapflow auto-IDLEs while we wait.
          while (!this.stopped && client.usable) {
            await client.idle();
          }
        } finally {
          lock.release();
        }

        try { await client.logout(); } catch { /* ignore */ }
      } catch (err) {
        this.ready = false;
        if (this.stopped) break;
        bLog.error("imap watch loop error", err);
      } finally {
        this.ready = false;
      }

      if (this.stopped) break;
      bLog.warn("reconnecting", { delayMs: this.reconnectDelay });
      await new Promise((r) => setTimeout(r, this.reconnectDelay));
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60_000);
    }
    this.watching = false;
  }

  private async processUnseen(client: ImapFlow, onMessage: (inbound: ParsedInbound, raw: { uid: number }) => Promise<void>): Promise<void> {
    const uids = (await client.search({ seen: false }, { uid: true })) || [];
    if (!uids || uids.length === 0) return;
    for (const uid of uids) {
      try {
        const msg = await client.fetchOne(String(uid), { source: true, uid: true }, { uid: true });
        if (!msg || !msg.source) continue;
        const parsed = await parseRfc822(msg.source);
        await onMessage(parsed, { uid: Number(uid) });
        // Mark seen so we don't re-deliver.
        await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
      } catch (err) {
        bLog.error("failed to process inbound", err, { uid });
      }
    }
  }
}
