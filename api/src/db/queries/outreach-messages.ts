import { db, generateId } from "@/db/index.ts";
import type { OutreachMessageRow, OutreachMessageStatus } from "@/db/types.ts";

export function insertOutreachMessage(data: {
  leadId: string;
  projectId: string;
  channel: string;
  subject?: string;
  body: string;
  status?: OutreachMessageStatus;
}): OutreachMessageRow {
  const id = generateId();
  db.run(
    `INSERT INTO outreach_messages (id, lead_id, project_id, channel, subject, body, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      data.leadId,
      data.projectId,
      data.channel,
      data.subject ?? "",
      data.body,
      data.status ?? "pending",
    ],
  );
  return db.query<OutreachMessageRow, [string]>("SELECT * FROM outreach_messages WHERE id = ?").get(id)!;
}

export function getMessageById(id: string): OutreachMessageRow | null {
  return db.query<OutreachMessageRow, [string]>(
    "SELECT * FROM outreach_messages WHERE id = ?",
  ).get(id) ?? null;
}

export function getMessagesByLead(leadId: string): OutreachMessageRow[] {
  return db.query<OutreachMessageRow, [string]>(
    "SELECT * FROM outreach_messages WHERE lead_id = ? ORDER BY created_at DESC",
  ).all(leadId);
}

export function updateMessageStatus(
  id: string,
  status: OutreachMessageStatus,
  extra?: { sentAt?: string; repliedAt?: string; error?: string; replyBody?: string },
): OutreachMessageRow {
  const sets = ["status = ?"];
  const values: (string | null)[] = [status];

  if (extra?.sentAt) { sets.push("sent_at = ?"); values.push(extra.sentAt); }
  if (extra?.repliedAt) { sets.push("replied_at = ?"); values.push(extra.repliedAt); }
  if (extra?.error !== undefined) { sets.push("error = ?"); values.push(extra.error); }
  if (extra?.replyBody !== undefined) { sets.push("reply_body = ?"); values.push(extra.replyBody); }

  values.push(id);
  db.run(`UPDATE outreach_messages SET ${sets.join(", ")} WHERE id = ?`, values);
  return db.query<OutreachMessageRow, [string]>("SELECT * FROM outreach_messages WHERE id = ?").get(id)!;
}

export function updateMessageBody(
  id: string,
  body: string,
  subject?: string,
): OutreachMessageRow {
  const sets = ["body = ?"];
  const values: string[] = [body];
  if (subject !== undefined) {
    sets.push("subject = ?");
    values.push(subject);
  }
  values.push(id);
  db.run(
    `UPDATE outreach_messages SET ${sets.join(", ")} WHERE id = ? AND status IN ('pending', 'approved')`,
    values,
  );
  return db.query<OutreachMessageRow, [string]>("SELECT * FROM outreach_messages WHERE id = ?").get(id)!;
}

export function getApprovedMessagesByProject(projectId: string): OutreachMessageRow[] {
  return db.query<OutreachMessageRow, [string]>(
    "SELECT * FROM outreach_messages WHERE project_id = ? AND status = 'approved' ORDER BY created_at ASC",
  ).all(projectId);
}

export function getSentMessagesByProject(projectId: string): OutreachMessageRow[] {
  return db.query<OutreachMessageRow, [string]>(
    "SELECT * FROM outreach_messages WHERE project_id = ? AND status IN ('sent', 'delivered') ORDER BY created_at ASC",
  ).all(projectId);
}

export function recordReply(
  id: string,
  replyBody: string,
): OutreachMessageRow {
  const now = new Date().toISOString();
  db.run(
    `UPDATE outreach_messages SET status = 'replied', reply_body = ?, replied_at = ? WHERE id = ?`,
    [replyBody, now, id],
  );
  return db.query<OutreachMessageRow, [string]>("SELECT * FROM outreach_messages WHERE id = ?").get(id)!;
}
