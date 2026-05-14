/**
 * Inbound email → project chat router.
 *
 * The mailbox registry knows which project owns each IMAP connection, so it
 * hands us `projectId` directly — no subaddressing or token demuxing here.
 *
 * 1. Compute a thread key from RFC headers; find or create the email chat.
 * 2. Persist attachments under inbox/<chatId>/<filename>.
 * 3. Insert into email_messages, emit `email.received`.
 * 4. Run the agent turn against the chat. The agent replies (when it wants
 *    to) by invoking `zero email reply <id> --body <text>` from its shell —
 *    we do NOT auto-send the assistant's text as an email.
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { projectDirFor, sessionsDirFor } from "@/lib/pi/run-turn.ts";
import { log } from "@/lib/utils/logger.ts";
import { generateId, db } from "@/db/index.ts";
import type { ChatRow, ProjectRow } from "@/db/types.ts";
import { runTurn } from "@/lib/pi/run-turn.ts";
import { resolveModelForPi } from "@/lib/pi/model.ts";
import { getActiveProvider } from "@/lib/providers/index.ts";
import { beginChatStream, endChatStream, publishPiEvent } from "@/lib/http/ws.ts";
import { events as eventBus } from "@/lib/scheduling/events.ts";

import { getProjectById } from "@/db/queries/projects.ts";
import {
  insertEmailMessage,
  findChatIdByThreadKey,
  countOutboundSince,
  outboundForChat,
  getEmailMessageByMessageId,
} from "@/db/queries/email-messages.ts";

import { newMessageIdLocalPart } from "@/lib/email-global/addressing.ts";
import {
  deriveThreadKey,
  buildOutboundReferences,
  normaliseMessageId,
  parseReferenceIds,
} from "@/lib/email-global/threading.ts";
import { sendForProject } from "@/lib/email-global/mailbox.ts";
import { stripQuotedReply, type ParsedInbound, type ParsedAttachment } from "@/lib/email-global/parser.ts";
import { markdownToHtml, replySubject } from "./format.ts";

const rLog = log.child({ module: "chat-providers/email" });

const chatLocks = new Map<string, Promise<void>>();
function withChatLock(key: string, fn: () => Promise<void>): Promise<void> {
  const prev = chatLocks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  chatLocks.set(key, next);
  next.finally(() => {
    if (chatLocks.get(key) === next) chatLocks.delete(key);
  });
  return next;
}

const insertChatStmt = db.prepare(
  "INSERT INTO chats (id, project_id, title, source, created_by) VALUES (?, ?, ?, 'email', ?) RETURNING *",
);
const touchChatStmt = db.prepare("UPDATE chats SET updated_at = datetime('now') WHERE id = ?");

const MAX_ATTACHMENT_TOTAL = 25 * 1024 * 1024;
const OUTREACH_RATE_PER_HOUR = 60;

function createEmailChat(projectId: string, subject: string, userId: string): ChatRow {
  const id = generateId();
  return insertChatStmt.get(id, projectId, `Email: ${subject}`, userId) as ChatRow;
}

async function storeAttachments(
  projectId: string,
  chatId: string,
  attachments: ParsedAttachment[],
): Promise<Array<{ path: string; name: string; mime: string; sizeBytes: number }>> {
  if (attachments.length === 0) return [];
  const total = attachments.reduce((acc, a) => acc + a.sizeBytes, 0);
  if (total > MAX_ATTACHMENT_TOTAL) {
    rLog.warn("attachments exceed cap, dropping", { projectId, chatId, total });
    return [];
  }
  const dir = join(projectDirFor(projectId), "inbox", chatId);
  await mkdir(dir, { recursive: true });
  const out: Array<{ path: string; name: string; mime: string; sizeBytes: number }> = [];
  for (const a of attachments) {
    const safeName = a.filename.replace(/[/\\\0]/g, "_");
    const filePath = join(dir, safeName);
    await writeFile(filePath, a.content);
    out.push({
      path: `inbox/${chatId}/${safeName}`,
      name: safeName,
      mime: a.mime,
      sizeBytes: a.sizeBytes,
    });
  }
  return out;
}

function buildOutboundRecap(rows: Array<{ subject: string; body_text: string | null; to_addrs: string; context: string | null }>): string {
  const parts: string[] = ["Earlier in this thread you sent:"];
  for (const r of rows) {
    let to: string[] = [];
    try { to = JSON.parse(r.to_addrs) as string[]; } catch { /* ignore */ }
    parts.push("");
    parts.push(`To: ${to.join(", ")}`);
    parts.push(`Subject: ${r.subject}`);
    if (r.context) {
      parts.push(`Context: ${r.context}`);
    }
    parts.push("");
    parts.push(r.body_text ?? "(no body)");
  }
  return parts.join("\n");
}

function composeUserMessage(
  parsed: ParsedInbound,
  attachments: Array<{ path: string; name: string }>,
  priorOutbound: Array<{ subject: string; body_text: string | null; to_addrs: string; context: string | null }>,
  inboundEmailId: string,
): string {
  const cleaned = stripQuotedReply(parsed.text).trim();
  const sender = parsed.fromAddr ?? parsed.from;
  const lines: string[] = [];
  if (priorOutbound.length > 0) {
    lines.push(buildOutboundRecap(priorOutbound));
    lines.push("");
    lines.push("---");
    lines.push("");
  }
  lines.push(`New email from ${sender}.`);
  lines.push(`To reply, run: zero email reply ${inboundEmailId} --body "<your message>"`);
  lines.push("");
  lines.push(`Subject: ${parsed.subject}`);
  lines.push("");
  lines.push(cleaned || "(empty body)");
  if (attachments.length > 0) {
    lines.push("");
    lines.push("Attachments:");
    for (const a of attachments) lines.push(`- ${a.path}`);
  }
  return lines.join("\n");
}

/**
 * Resolve the thread key for an inbound email.
 *
 * Some mail clients (notably iOS Mail on reply) re-root the References chain
 * or strip everything but the most recent id. That breaks the simple
 * "refs[0] is the conversation root" heuristic in deriveThreadKey: the
 * inbound's derived key won't match the thread_key we stored earlier, and a
 * new chat gets created. So we first walk every id we can see (References +
 * In-Reply-To) and reuse the thread_key of any message we already have on
 * file. Only fall back to deriveThreadKey when nothing matches.
 */
function resolveThreadKey(projectId: string, parsed: ParsedInbound): string {
  const candidates: string[] = [];
  for (const r of parseReferenceIds(parsed.references)) candidates.push(r);
  const ir = normaliseMessageId(parsed.inReplyTo);
  if (ir) candidates.push(ir);
  for (const id of candidates) {
    const row = getEmailMessageByMessageId(id);
    if (row && row.project_id === projectId) return row.thread_key;
  }
  return deriveThreadKey({
    messageId: parsed.messageId,
    inReplyTo: parsed.inReplyTo,
    references: parsed.references,
  });
}

export async function handleIncomingEmail(projectId: string, parsed: ParsedInbound): Promise<void> {
  const project = getProjectById(projectId);
  if (!project || project.email_enabled !== 1) {
    rLog.info("project no longer accepts email — dropping", { projectId });
    return;
  }

  const threadKey = resolveThreadKey(project.id, parsed);

  await withChatLock(`email:${project.id}:${threadKey}`, async () => {
    let chatId = findChatIdByThreadKey(project.id, threadKey);
    if (!chatId) {
      const chat = createEmailChat(project.id, parsed.subject, project.user_id);
      chatId = chat.id;
    }

    const storedAttachments = await storeAttachments(project.id, chatId, parsed.attachments);

    const inboundRow = insertEmailMessage({
      projectId: project.id,
      chatId,
      direction: "in",
      messageIdHdr: normaliseMessageId(parsed.messageId) ?? `<orphan-${generateId()}>`,
      inReplyTo: normaliseMessageId(parsed.inReplyTo),
      referencesHdr: parsed.references,
      threadKey,
      fromAddr: parsed.fromAddr ?? "",
      toAddrs: parsed.to,
      subject: parsed.subject,
      bodyText: parsed.text,
      bodyHtml: parsed.html,
      attachments: storedAttachments,
    });

    eventBus.emit("email.received", {
      projectId: project.id,
      chatId,
      threadKey,
      from: parsed.fromAddr ?? "",
      subject: parsed.subject,
      hasAttachments: storedAttachments.length > 0,
      messageId: normaliseMessageId(parsed.messageId) ?? "",
    });

    await runEmailAgentTurn(project, chatId, parsed, inboundRow.id, storedAttachments);
  });
}

async function runEmailAgentTurn(
  project: ProjectRow,
  chatId: string,
  parsed: ParsedInbound,
  inboundEmailId: string,
  attachments: Array<{ path: string; name: string }>,
): Promise<void> {
  const isFirstTurn = !existsSync(join(sessionsDirFor(project.id), `${chatId}.jsonl`));
  const priorOutbound = isFirstTurn ? outboundForChat(project.id, chatId) : [];
  const userText = composeUserMessage(parsed, attachments, priorOutbound, inboundEmailId);
  const chatModelId = getActiveProvider().getDefaultChatModelId();
  const resolved = resolveModelForPi(chatModelId);

  beginChatStream(chatId, "");
  let turnError: string | null = null;
  try {
    const turn = await runTurn({
      projectId: project.id,
      chatId,
      userId: project.user_id,
      userMessage: userText,
      model: resolved,
      onEvent: (env) => {
        publishPiEvent(env);
      },
    });
    if (turn.truncated) {
      turnError = `model response truncated: ${turn.truncationReason ?? "no stop_reason"}`;
      rLog.warn("email agent turn truncated", { chatId, reason: turn.truncationReason });
    }
  } catch (err) {
    turnError = err instanceof Error ? err.message : String(err);
    rLog.error("email agent turn failed", err);
  } finally {
    endChatStream(chatId, turnError ? "error" : "completed", turnError ?? undefined);
  }

  touchChatStmt.run(chatId);
}

function buildFromHeader(project: ProjectRow): string | null {
  if (!project.email_address) return null;
  const name = project.email_from_name || project.name;
  return `${name} <${project.email_address}>`;
}

function projectDomain(project: ProjectRow): string | null {
  if (!project.email_address) return null;
  const at = project.email_address.lastIndexOf("@");
  return at > 0 ? project.email_address.slice(at + 1) : null;
}

// ── Outreach / programmatic sends from CLI handlers ──

export interface OutreachInput {
  projectId: string;
  to: string[];
  subject: string;
  body: string;
  attachments?: Array<{ filename: string; content: Buffer; contentType: string }>;
  inReplyToId?: string | null;
  context?: string | null;
}

export async function sendProjectEmail(input: OutreachInput): Promise<{ ok: boolean; messageId: string; chatId: string | null; error?: string }> {
  const project = getProjectById(input.projectId);
  if (!project) return { ok: false, messageId: "", chatId: null, error: "project not found" };
  if (project.email_enabled !== 1 || !project.email_address) {
    return { ok: false, messageId: "", chatId: null, error: "email not enabled for project" };
  }
  const from = buildFromHeader(project);
  const domain = projectDomain(project);
  if (!from || !domain) {
    return { ok: false, messageId: "", chatId: null, error: "project mailbox not configured" };
  }

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
  if (countOutboundSince(input.projectId, oneHourAgo) >= OUTREACH_RATE_PER_HOUR) {
    return { ok: false, messageId: "", chatId: null, error: `rate limit: max ${OUTREACH_RATE_PER_HOUR} outbound per hour` };
  }

  const ownMessageId = `<${newMessageIdLocalPart()}@${domain}>`;

  let inReplyTo: string | null = null;
  let references: string | null = null;
  let threadKey: string;
  let chatId: string | null = null;
  let subject = input.subject;

  if (input.inReplyToId) {
    const parent = db.prepare("SELECT * FROM email_messages WHERE id = ?").get(input.inReplyToId) as
      | { project_id: string; chat_id: string | null; message_id_hdr: string; references_hdr: string | null; thread_key: string; subject: string }
      | undefined;
    if (!parent || parent.project_id !== input.projectId) {
      return { ok: false, messageId: "", chatId: null, error: "parent message not found" };
    }
    const built = buildOutboundReferences({
      messageId: parent.message_id_hdr,
      inReplyTo: null,
      references: parent.references_hdr,
    });
    inReplyTo = built.inReplyTo;
    references = built.references;
    threadKey = parent.thread_key;
    chatId = parent.chat_id;
    subject = replySubject(parent.subject);
  } else {
    threadKey = ownMessageId;
    const chat = createEmailChat(project.id, subject, project.user_id);
    chatId = chat.id;
  }

  const result = await sendForProject(input.projectId, {
    from,
    to: input.to,
    subject,
    text: input.body,
    html: markdownToHtml(input.body),
    inReplyTo,
    references,
    messageId: ownMessageId,
    attachments: input.attachments,
  });
  if (!result.ok) return { ok: false, messageId: ownMessageId, chatId, error: result.error };

  insertEmailMessage({
    projectId: project.id,
    chatId,
    direction: "out",
    messageIdHdr: result.messageId,
    inReplyTo,
    referencesHdr: references,
    threadKey,
    fromAddr: project.email_address,
    toAddrs: input.to,
    subject,
    bodyText: input.body,
    bodyHtml: markdownToHtml(input.body),
    attachments: input.attachments?.map((a) => ({ path: `outbox/${a.filename}`, name: a.filename, mime: a.contentType, sizeBytes: a.content.length })) ?? [],
    context: input.context ?? null,
  });

  eventBus.emit("email.sent", {
    projectId: project.id,
    chatId: chatId ?? "",
    threadKey,
    to: input.to.join(", "),
    subject,
  });

  return { ok: true, messageId: result.messageId, chatId };
}
