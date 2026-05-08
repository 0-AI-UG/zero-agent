/**
 * WebSocket chat handlers — Pi-backed.
 *
 * Routes `chat.send` / `chat.stop` / `chat.regenerate` from `ws.ts` into
 * `runTurn(...)`. Pi owns conversation history (one JSONL per chat under
 * `<project>/.pi-sessions/<chatId>.jsonl`) so this module no longer
 * persists messages, builds prompt history, or strips planning parts —
 * Pi's session manager handles all of that.
 *
 * Per-`chatId` AbortController is preserved for `chat.stop`.
 */
import type { WebSocket } from "ws";
import { log } from "@/lib/utils/logger.ts";

import { getProjectById } from "@/db/queries/projects.ts";
import { getChatById } from "@/db/queries/chats.ts";
import { isProjectMember } from "@/db/queries/members.ts";
import { getUserById } from "@/db/queries/users.ts";

import {
  createAbortController,
  requestAbort,
  clearAbortController,
} from "@/lib/http/chat-aborts.ts";
import {
  beginChatStream,
  endChatStream,
  isChatStreaming as chatIsStreaming,
  publishPiEvent,
} from "@/lib/http/ws.ts";
import { runTurn } from "@/lib/pi/run-turn.ts";
import { resolveModelForPi } from "@/lib/pi/model.ts";

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
  model?: string;
}

interface ChatStopMessage {
  type: "chat.stop";
  chatId: string;
}

interface ChatRegenerateMessage {
  type: "chat.regenerate";
  chatId: string;
  // Pi's session manager owns regenerate semantics. v1 just spawns a new
  // turn with the supplied text; richer fork/regenerate is open question §8.
  text?: string;
  model?: string;
}

export type ChatWsMessage =
  | ChatSendMessage
  | ChatStopMessage
  | ChatRegenerateMessage;

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
    case "chat.regenerate":
      await handleChatSend(ws, meta, msg);
      return;
    case "chat.stop":
      handleChatStop(ws, meta, msg);
      return;
  }
}

// ────────────────────────────────────────────────────────────────────────
//  chat.send / chat.regenerate
// ────────────────────────────────────────────────────────────────────────

async function handleChatSend(
  ws: WebSocket,
  meta: ChatConnectionMeta,
  msg: ChatSendMessage | ChatRegenerateMessage,
): Promise<void> {
  if (!msg.chatId) {
    sendError(ws, `${msg.type}: missing chatId`);
    return;
  }

  const context = getAuthorizedChatContext(meta.userId, msg.chatId);
  if ("error" in context) {
    sendError(ws, context.error.replace("chat.send", msg.type));
    return;
  }
  const { chat, project } = context;

  if (chatIsStreaming(chat.id)) {
    sendError(ws, `${msg.type}: chat is already streaming`);
    return;
  }

  const text = (msg.text ?? "").trim();
  if (!text) {
    sendError(ws, `${msg.type}: empty message`);
    return;
  }

  const abortController = createAbortController(chat.id);

  let resolved;
  try {
    resolved = resolveModelForPi(msg.model);
  } catch (err) {
    sendError(ws, `${msg.type}: ${err instanceof Error ? err.message : String(err)}`);
    clearAbortController(chat.id);
    return;
  }

  // Begin the WS scene before runTurn so viewer joins mid-run see the
  // streaming flag immediately. The runId comes back from runTurn but we
  // don't have it yet; emit a placeholder and let the first pi.event
  // carry the canonical runId.
  beginChatStream(chat.id, "");

  void runTurn({
    projectId: project.id,
    chatId: chat.id,
    userId: meta.userId,
    userMessage: text,
    model: resolved.model,
    authStorage: resolved.authStorage,
    abortSignal: abortController.signal,
    onEvent: (env) => publishPiEvent(env),
  })
    .then(({ runId, aborted }) => {
      endChatStream(chat.id, aborted ? "aborted" : "completed");
      chatLog.info("pi turn finished", { chatId: chat.id, runId, aborted });
    })
    .catch((err) => {
      const errorMsg = err instanceof Error ? err.message : String(err);
      chatLog.error("pi turn failed", err, { chatId: chat.id });
      endChatStream(chat.id, "error", errorMsg);
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
//  Helpers
// ────────────────────────────────────────────────────────────────────────

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
