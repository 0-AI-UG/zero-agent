import { db, generateId } from "@/db/index.ts";
import type { ChannelRow, ChannelMessageRow, ChatRow } from "@/db/types.ts";

// --- Channel CRUD ---

export function insertChannel(
  projectId: string,
  data: { platform: string; name: string; credentials: string; allowedSenders: string },
): ChannelRow {
  const id = generateId();
  db.run(
    `INSERT INTO channels (id, project_id, platform, name, credentials, allowed_senders)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, projectId, data.platform, data.name, data.credentials, data.allowedSenders],
  );
  return db.query<ChannelRow, [string]>(
    "SELECT * FROM channels WHERE id = ?",
  ).get(id)!;
}

export function getChannelsByProject(projectId: string): ChannelRow[] {
  return db.query<ChannelRow, [string]>(
    "SELECT * FROM channels WHERE project_id = ? ORDER BY created_at DESC",
  ).all(projectId);
}

export function getChannelById(id: string): ChannelRow | null {
  return db.query<ChannelRow, [string]>(
    "SELECT * FROM channels WHERE id = ?",
  ).get(id) ?? null;
}

export function getEnabledChannels(): ChannelRow[] {
  return db.query<ChannelRow, []>(
    "SELECT * FROM channels WHERE enabled = 1",
  ).all();
}

export function updateChannel(
  id: string,
  fields: {
    name?: string;
    credentials?: string;
    allowedSenders?: string;
    enabled?: boolean;
  },
): ChannelRow {
  const updates: string[] = [];
  const values: (string | number)[] = [];

  if (fields.name !== undefined) {
    updates.push("name = ?");
    values.push(fields.name);
  }
  if (fields.credentials !== undefined) {
    updates.push("credentials = ?");
    values.push(fields.credentials);
  }
  if (fields.allowedSenders !== undefined) {
    updates.push("allowed_senders = ?");
    values.push(fields.allowedSenders);
  }
  if (fields.enabled !== undefined) {
    updates.push("enabled = ?");
    values.push(fields.enabled ? 1 : 0);
  }

  updates.push("updated_at = datetime('now')");
  values.push(id);

  db.run(
    `UPDATE channels SET ${updates.join(", ")} WHERE id = ?`,
    values,
  );

  return db.query<ChannelRow, [string]>(
    "SELECT * FROM channels WHERE id = ?",
  ).get(id)!;
}

export function deleteChannel(id: string): void {
  db.run("DELETE FROM channels WHERE id = ?", [id]);
}

// --- Channel Chat Management ---

const channelChatStmt = db.query<ChatRow, [string, string]>(
  "SELECT c.* FROM chats c INNER JOIN channel_messages cm ON cm.chat_id = c.id WHERE cm.channel_id = ? AND cm.external_chat_id = ? LIMIT 1",
);

export function getOrCreateChannelChat(
  projectId: string,
  channelId: string,
  externalChatId: string,
  platform: string,
): ChatRow {
  const existing = channelChatStmt.get(channelId, externalChatId);
  if (existing) return existing;

  const id = generateId();
  db.run(
    "INSERT INTO chats (id, project_id, title, source) VALUES (?, ?, ?, ?)",
    [id, projectId, "New Chat", platform],
  );
  return db.query<ChatRow, [string]>("SELECT * FROM chats WHERE id = ?").get(id)!;
}

// --- Channel Messages ---

export function insertChannelMessage(data: {
  channelId: string;
  projectId: string;
  chatId: string;
  externalChatId: string;
  externalMessageId?: string;
  senderIdentifier: string;
  direction: "inbound" | "outbound";
  contentText: string;
}): ChannelMessageRow {
  const id = generateId();
  db.run(
    `INSERT INTO channel_messages (id, channel_id, project_id, chat_id, external_chat_id, external_message_id, sender_identifier, direction, content_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, data.channelId, data.projectId, data.chatId, data.externalChatId, data.externalMessageId ?? null, data.senderIdentifier, data.direction, data.contentText],
  );
  return db.query<ChannelMessageRow, [string]>(
    "SELECT * FROM channel_messages WHERE id = ?",
  ).get(id)!;
}

export function getChannelMessagesByChat(chatId: string): ChannelMessageRow[] {
  return db.query<ChannelMessageRow, [string]>(
    "SELECT * FROM channel_messages WHERE chat_id = ? ORDER BY created_at ASC",
  ).all(chatId);
}
