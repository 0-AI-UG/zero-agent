/**
 * Backend abstraction so the IMAP+SMTP implementation can be swapped for a
 * hosted provider (Postmark, Resend, …) later without touching the
 * ChatProvider, router, or CLI surface.
 */
import type { ParsedInbound, ParsedAttachment } from "./parser.ts";

export interface OutboundMessage {
  from: string;             // "Display Name <addr>"
  to: string[];
  subject: string;
  text: string;
  html: string | null;
  replyTo?: string;
  inReplyTo?: string | null;
  references?: string | null;
  messageId: string;        // we always set this so we can persist it
  attachments?: Array<{ filename: string; content: Buffer; contentType: string }>;
}

export interface SendResult {
  ok: boolean;
  messageId: string;
  error?: string;
}

export interface EmailBackend {
  send(msg: OutboundMessage): Promise<SendResult>;
  /** Open the inbox and call `onMessage` for each new incoming mail. */
  startWatching(onMessage: (inbound: ParsedInbound, raw: { uid: number }) => Promise<void>): Promise<void>;
  close(): Promise<void>;
  /** True once startWatching has connected and selected the inbox. */
  isReady(): boolean;
}

export type { ParsedInbound, ParsedAttachment };
