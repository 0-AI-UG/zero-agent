/**
 * WebSocket chat handlers.
 *
 * Dispatches `chat.send` / `chat.stop` / `chat.regenerate` /
 * `chat.approve` from the per-connection switch in `ws.ts`. Owns the
 * per-`chatId` AbortController for `chat.stop`. The streaming run kicks
 * off `ws-entrypoint.ts`, which mutates the per-chat scene in `ws.ts` —
 * that module broadcasts to current viewers directly.
 */
import type { WebSocket } from "ws";
import { generateId } from "@/db/index.ts";
import { log } from "@/lib/utils/logger.ts";

import { getProjectById } from "@/db/queries/projects.ts";
import { getChatById } from "@/db/queries/chats.ts";
import { isProjectMember } from "@/db/queries/members.ts";
import { getUserById } from "@/db/queries/users.ts";
import { getMessagesByChat } from "@/db/queries/messages.ts";
import { saveChatMessages } from "@/db/queries/messages.ts";

import {
  createAbortController,
  requestAbort,
  clearAbortController,
} from "@/lib/http/chat-aborts.ts";
import { runAgentStepStreaming } from "@/lib/agent-step/index.ts";
import { isChatStreaming as chatIsStreaming } from "@/lib/http/ws.ts";
import { resolvePendingSync } from "@/lib/sync-approval.ts";

import type { Message, Part } from "@/lib/messages/types.ts";

const chatLog = log.child({ module: "ws-chat" });

// ────────────────────────────────────────────────────────────────────────
//  Types
// ────────────────────────────────────────────────────────────────────────

export interface ChatConnectionMeta {
  userId: string;
  username: string;
  projectId: string | null;
  chatId: string | null;
}

type AuthorizedChatContext =
  | {
      chat: NonNullable<ReturnType<typeof getChatById>>;
      project: NonNullable<ReturnType<typeof getProjectById>>;
    }
  | { error: string };

interface ChatSendMessage {
  type: "chat.send";
  chatId: string;
  text?: string;
  attachments?: Part[];
  model?: string;
  language?: "en" | "zh";
  disabledTools?: string[];
  planMode?: boolean;
}

interface ChatStopMessage {
  type: "chat.stop";
  chatId: string;
}

interface ChatRegenerateMessage {
  type: "chat.regenerate";
  chatId: string;
  messageId: string;
  model?: string;
  language?: "en" | "zh";
  disabledTools?: string[];
  planMode?: boolean;
}

interface ChatApproveMessage {
  type: "chat.approve";
  syncId: string;
  verdict: "approve" | "reject";
}

export type ChatWsMessage =
  | ChatSendMessage
  | ChatStopMessage
  | ChatRegenerateMessage
  | ChatApproveMessage;

// ────────────────────────────────────────────────────────────────────────
//  Dispatcher
// ────────────────────────────────────────────────────────────────────────

export function isChatWsMessage(msg: { type?: string }): msg is ChatWsMessage {
  return typeof msg.type === "string" && msg.type.startsWith("chat.");
}

export async function handleChatMessage(
  ws: WebSocket,
  meta: ChatConnectionMeta,
  msg: ChatWsMessage,
): Promise<void> {
  switch (msg.type) {
    case "chat.send":
      await handleChatSend(ws, meta, msg);
      return;
    case "chat.stop":
      handleChatStop(ws, meta, msg);
      return;
    case "chat.regenerate":
      await handleChatRegenerate(ws, meta, msg);
      return;
    case "chat.approve":
      handleChatApprove(ws, meta, msg);
      return;
  }
}

// ────────────────────────────────────────────────────────────────────────
//  chat.send
// ────────────────────────────────────────────────────────────────────────

async function handleChatSend(
  ws: WebSocket,
  meta: ChatConnectionMeta,
  msg: ChatSendMessage,
): Promise<void> {
  if (!msg.chatId) {
    sendError(ws, "chat.send: missing chatId");
    return;
  }

  const context = getAuthorizedChatContext(meta.userId, msg.chatId);
  if ("error" in context) {
    sendError(ws, context.error);
    return;
  }
  const { chat, project } = context;

  if (chatIsStreaming(chat.id)) {
    sendError(ws, "chat.send: chat is already streaming");
    return;
  }

  // Build the new user message from text + attachments. Server owns history.
  const newUserParts: Part[] = [];
  if (msg.text) newUserParts.push({ type: "text", text: msg.text });
  if (Array.isArray(msg.attachments)) newUserParts.push(...msg.attachments);
  if (newUserParts.length === 0) {
    sendError(ws, "chat.send: empty message");
    return;
  }
  const userMessage: Message = {
    id: generateId(),
    role: "user",
    parts: newUserParts,
  };

  // Load prior history from DB, append the new user message.
  const prior = getMessagesByChat(chat.id)
    .map((row) => {
      try {
        return JSON.parse(row.content) as Message;
      } catch {
        return null;
      }
    })
    .filter((m): m is Message => m != null && (m.parts?.length ?? 0) > 0);
  const messages: Message[] = [...prior, userMessage];

  // Persist the user message up front so a hard crash mid-stream doesn't lose
  // the user's input.
  try {
    saveChatMessages(
      project.id,
      chat.id,
      [{ id: userMessage.id, role: userMessage.role, content: JSON.stringify(userMessage) }],
      meta.userId,
    );
  } catch (err) {
    chatLog.warn("failed to pre-persist user message", {
      chatId: chat.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Strip planning tool parts from prior history when plan mode is off.
  const cleaned = msg.planMode ? messages : stripPlanToolParts(messages);

  const streamId = generateId();
  const abortController = createAbortController(chat.id);

  // Fire off the streaming run. ws-entrypoint mutates the per-chat scene
  // in ws.ts, which broadcasts to current viewers. We don't await so the
  // WS handler doesn't block the connection's read loop.
  void runAgentStepStreaming({
    project: { id: project.id, name: project.name },
    chatId: chat.id,
    userId: meta.userId,
    username: meta.username,
    model: msg.model,
    language: msg.language,
    disabledTools: msg.disabledTools,
    planMode: msg.planMode,
    messages: cleaned,
    abortSignal: abortController.signal,
    streamId,
  })
    .catch((err) => {
      chatLog.error("ws chat run failed", err, { chatId: chat.id });
    })
    .finally(() => {
      clearAbortController(chat.id);
    });
}

// ────────────────────────────────────────────────────────────────────────
//  chat.regenerate
// ────────────────────────────────────────────────────────────────────────

async function handleChatRegenerate(
  ws: WebSocket,
  meta: ChatConnectionMeta,
  msg: ChatRegenerateMessage,
): Promise<void> {
  if (!msg.chatId || !msg.messageId) {
    sendError(ws, "chat.regenerate: missing chatId or messageId");
    return;
  }

  const context = getAuthorizedChatContext(meta.userId, msg.chatId);
  if ("error" in context) {
    sendError(ws, context.error.replace("chat.send", "chat.regenerate"));
    return;
  }
  const { chat, project } = context;

  if (chatIsStreaming(chat.id)) {
    sendError(ws, "chat.regenerate: chat is already streaming");
    return;
  }

  const messages = getMessagesByChat(chat.id)
    .map((row) => {
      try {
        return JSON.parse(row.content) as Message;
      } catch {
        return null;
      }
    })
    .filter((m): m is Message => m != null && (m.parts?.length ?? 0) > 0);

  const targetIndex = messages.findIndex((m) => m.id === msg.messageId);
  if (targetIndex < 0) {
    sendError(ws, "chat.regenerate: message not found");
    return;
  }

  const target = messages[targetIndex]!;
  if (target.role !== "assistant") {
    sendError(ws, "chat.regenerate: target message must be assistant");
    return;
  }

  const trimmed = messages.slice(0, targetIndex);
  const last = trimmed[trimmed.length - 1];
  if (!last || last.role !== "user") {
    sendError(ws, "chat.regenerate: no preceding user turn to replay");
    return;
  }

  const cleaned = msg.planMode ? trimmed : stripPlanToolParts(trimmed);
  const streamId = generateId();
  const abortController = createAbortController(chat.id);

  void runAgentStepStreaming({
    project: { id: project.id, name: project.name },
    chatId: chat.id,
    userId: meta.userId,
    username: meta.username,
    model: msg.model,
    language: msg.language,
    disabledTools: msg.disabledTools,
    planMode: msg.planMode,
    messages: cleaned,
    abortSignal: abortController.signal,
    streamId,
  })
    .catch((err) => {
      chatLog.error("ws chat regenerate failed", err, { chatId: chat.id });
    })
    .finally(() => {
      clearAbortController(chat.id);
    });
}

// ────────────────────────────────────────────────────────────────────────
//  chat.stop
// ────────────────────────────────────────────────────────────────────────

function handleChatStop(
  _ws: WebSocket,
  meta: ChatConnectionMeta,
  msg: ChatStopMessage,
): void {
  if (!msg.chatId) return;
  const aborted = requestAbort(msg.chatId);
  chatLog.info("chat.stop requested", {
    chatId: msg.chatId,
    userId: meta.userId,
    aborted,
  });
}

// ────────────────────────────────────────────────────────────────────────
//  chat.approve
// ────────────────────────────────────────────────────────────────────────

function handleChatApprove(
  ws: WebSocket,
  _meta: ChatConnectionMeta,
  msg: ChatApproveMessage,
): void {
  if (!msg.syncId || (msg.verdict !== "approve" && msg.verdict !== "reject")) {
    sendError(ws, "chat.approve: missing syncId or invalid verdict");
    return;
  }
  resolvePendingSync(msg.syncId, msg.verdict, "ws");
}

// ────────────────────────────────────────────────────────────────────────
//  Helpers
// ────────────────────────────────────────────────────────────────────────

function stripPlanToolParts(messages: Message[]): Message[] {
  return messages.map((m) => {
    if (!m.parts) return m;
    const filtered = m.parts.filter((p) => {
      if (p.type === "dynamic-tool" && p.toolName === "finishPlanning") return false;
      return true;
    });
    if (filtered.length === m.parts.length) return m;
    return { ...m, parts: filtered };
  });
}

function getAuthorizedChatContext(userId: string, chatId: string): AuthorizedChatContext {
  const chat = getChatById(chatId);
  if (!chat) {
    return { error: "chat.send: chat not found" };
  }

  const project = getProjectById(chat.project_id);
  if (!project) {
    return { error: "chat.send: project not found" };
  }

  const user = getUserById(userId);
  if (user?.is_admin !== 1 && !isProjectMember(project.id, userId)) {
    return { error: "chat.send: not a member of this project" };
  }

  return { chat, project } satisfies AuthorizedChatContext;
}

function sendError(ws: WebSocket, message: string): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type: "chat.error", message }));
  }
}
