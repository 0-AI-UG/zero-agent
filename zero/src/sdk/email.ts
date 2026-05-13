/**
 * Email SDK — list/read/send/reply/search the project's mailbox.
 *
 * `email.send` supports cold outreach (no inReplyToId) and threading replies
 * (when inReplyToId is supplied, the server pulls Subject/References from
 * the parent row).
 */
import { call, type CallOptions } from "./client.ts";
import {
  EmailListInput,
  EmailReadInput,
  EmailSendInput,
  EmailSearchInput,
} from "./schemas.ts";

export interface EmailSummary {
  id: string;
  direction: "in" | "out";
  threadKey: string;
  subject: string;
  from: string;
  to: string[];
  receivedAt: string;
  hasAttachments: boolean;
}

export interface EmailMessage extends EmailSummary {
  bodyText: string | null;
  bodyHtml: string | null;
  attachments: Array<{ path: string; name: string; mime: string; sizeBytes: number }>;
  inReplyTo: string | null;
  references: string | null;
}

export interface EmailSendResult {
  ok: boolean;
  messageId: string;
  chatId: string | null;
  error?: string;
}

export const email = {
  list(input: { unread?: boolean; threadKey?: string; from?: string; since?: string; limit?: number } = {}, options?: CallOptions): Promise<{ messages: EmailSummary[] }> {
    return call<{ messages: EmailSummary[] }>("/zero/email/list", EmailListInput.parse(input), options);
  },

  read(id: string, options?: CallOptions): Promise<EmailMessage> {
    return call<EmailMessage>("/zero/email/read", EmailReadInput.parse({ id }), options);
  },

  send(input: { to: string[]; subject: string; body: string; inReplyToId?: string; context?: string }, options?: CallOptions): Promise<EmailSendResult> {
    return call<EmailSendResult>("/zero/email/send", EmailSendInput.parse(input), options);
  },

  reply(inReplyToId: string, body: string, options?: CallOptions): Promise<EmailSendResult> {
    // Server derives `to` + `subject` from the parent row; we still need a
    // dummy `to` to satisfy the schema, but the handler overrides it.
    return call<EmailSendResult>(
      "/zero/email/send",
      EmailSendInput.parse({ to: ["_"], subject: "_", body, inReplyToId }),
      options,
    );
  },

  search(query: string, limit?: number, options?: CallOptions): Promise<{ messages: EmailSummary[] }> {
    return call<{ messages: EmailSummary[] }>("/zero/email/search", EmailSearchInput.parse({ query, limit }), options);
  },
};
