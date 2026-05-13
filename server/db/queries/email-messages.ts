import { db, generateId } from "@/db/index.ts";
import type { EmailMessageRow } from "@/db/types.ts";

export interface InsertEmailMessage {
  projectId: string;
  chatId: string | null;
  direction: "in" | "out";
  messageIdHdr: string;
  inReplyTo: string | null;
  referencesHdr: string | null;
  threadKey: string;
  fromAddr: string;
  toAddrs: string[];
  subject: string;
  bodyText: string | null;
  bodyHtml: string | null;
  attachments: Array<{ path: string; name: string; mime: string; sizeBytes: number }>;
}

export function insertEmailMessage(input: InsertEmailMessage): EmailMessageRow {
  const id = generateId();
  db.prepare(
    `INSERT INTO email_messages
       (id, project_id, chat_id, direction, message_id_hdr, in_reply_to,
        references_hdr, thread_key, from_addr, to_addrs, subject,
        body_text, body_html, attachments)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    input.projectId,
    input.chatId,
    input.direction,
    input.messageIdHdr,
    input.inReplyTo,
    input.referencesHdr,
    input.threadKey,
    input.fromAddr,
    JSON.stringify(input.toAddrs),
    input.subject,
    input.bodyText,
    input.bodyHtml,
    input.attachments.length > 0 ? JSON.stringify(input.attachments) : null,
  );
  return db.prepare("SELECT * FROM email_messages WHERE id = ?").get(id) as EmailMessageRow;
}

export function getEmailMessageById(id: string): EmailMessageRow | null {
  return (db.prepare("SELECT * FROM email_messages WHERE id = ?").get(id) as EmailMessageRow | undefined) ?? null;
}

export function getEmailMessageByMessageId(messageIdHdr: string): EmailMessageRow | null {
  return (db.prepare("SELECT * FROM email_messages WHERE message_id_hdr = ?").get(messageIdHdr) as EmailMessageRow | undefined) ?? null;
}

export function findChatIdByThreadKey(projectId: string, threadKey: string): string | null {
  const row = db.prepare(
    "SELECT chat_id FROM email_messages WHERE project_id = ? AND thread_key = ? AND chat_id IS NOT NULL ORDER BY received_at ASC LIMIT 1",
  ).get(projectId, threadKey) as { chat_id: string | null } | undefined;
  return row?.chat_id ?? null;
}

export interface ListEmailFilter {
  projectId: string;
  unread?: boolean; // unread is "not yet replied to": no out row with thread_key matching
  threadKey?: string;
  from?: string;
  since?: string;
  limit?: number;
}

export function listEmailMessages(filter: ListEmailFilter): EmailMessageRow[] {
  const where: string[] = ["project_id = ?"];
  const params: (string | number)[] = [filter.projectId];

  if (filter.threadKey) {
    where.push("thread_key = ?");
    params.push(filter.threadKey);
  }
  if (filter.from) {
    where.push("from_addr LIKE ?");
    params.push(`%${filter.from}%`);
  }
  if (filter.since) {
    where.push("received_at >= ?");
    params.push(filter.since);
  }
  if (filter.unread) {
    // Inbound messages whose thread has no outbound reply yet.
    where.push(`direction = 'in'`);
    where.push(`NOT EXISTS (
      SELECT 1 FROM email_messages o
      WHERE o.project_id = email_messages.project_id
        AND o.thread_key = email_messages.thread_key
        AND o.direction = 'out'
        AND o.received_at > email_messages.received_at
    )`);
  }

  const limit = filter.limit ?? 50;
  return db
    .prepare(
      `SELECT * FROM email_messages WHERE ${where.join(" AND ")} ORDER BY received_at DESC LIMIT ?`,
    )
    .all(...params, limit) as EmailMessageRow[];
}

export function searchEmailMessages(projectId: string, query: string, limit = 50): EmailMessageRow[] {
  const like = `%${query}%`;
  return db
    .prepare(
      `SELECT * FROM email_messages
       WHERE project_id = ?
         AND (subject LIKE ? OR body_text LIKE ? OR from_addr LIKE ?)
       ORDER BY received_at DESC LIMIT ?`,
    )
    .all(projectId, like, like, like, limit) as EmailMessageRow[];
}

/** Most recent inbound row in a thread — used to source In-Reply-To/References for replies. */
export function latestInboundInThread(projectId: string, threadKey: string): EmailMessageRow | null {
  return (db
    .prepare(
      `SELECT * FROM email_messages
       WHERE project_id = ? AND thread_key = ? AND direction = 'in'
       ORDER BY received_at DESC LIMIT 1`,
    )
    .get(projectId, threadKey) as EmailMessageRow | undefined) ?? null;
}

export function countOutboundSince(projectId: string, sinceIso: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) as c FROM email_messages
       WHERE project_id = ? AND direction = 'out' AND received_at >= ?`,
    )
    .get(projectId, sinceIso) as { c: number };
  return row.c;
}
