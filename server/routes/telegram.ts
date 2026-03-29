import { corsHeaders } from "@/lib/cors.ts";
import { authenticateRequest } from "@/lib/auth.ts";
import { handleError, verifyProjectAccess } from "@/routes/utils.ts";
import { log } from "@/lib/logger.ts";
import { readFromS3, writeToS3, deleteFromS3, s3 } from "@/lib/s3.ts";
import {
  sendTelegramText,
  sendTelegramHtml,
  setTelegramWebhook,
  deleteTelegramWebhook,
  getTelegramBotInfo,
  downloadTelegramFile,
  type TelegramUpdate,
} from "@/lib/telegram.ts";
import {
  upsertTelegramBinding,
  getTelegramBinding,
  getTelegramBindingsByProject,
  deleteTelegramBindingsByProject,
  disableTelegramBinding,
} from "@/db/queries/telegram-bindings.ts";
import { db, generateId } from "@/db/index.ts";
import { createAgent } from "@/lib/agent.ts";
import { getProjectById } from "@/db/queries/projects.ts";
import { startPollingForProject, stopPollingForProject } from "@/lib/telegram-polling.ts";
import type { ChatRow, MessageRow } from "@/db/types.ts";
import type { ModelMessage } from "ai";
import { Jimp } from "jimp";

const tgLog = log.child({ module: "routes:telegram" });

const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";
const WEBHOOK_BASE_URL = process.env.TELEGRAM_WEBHOOK_BASE_URL ?? "";

// ── Per-chat concurrency: serialize messages from the same Telegram chat ──
const chatLocks = new Map<string, Promise<void>>();

function withChatLock(key: string, fn: () => Promise<void>): Promise<void> {
  const prev = chatLocks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn); // always run, even if prev failed
  chatLocks.set(key, next);
  // Cleanup when done
  next.finally(() => {
    if (chatLocks.get(key) === next) chatLocks.delete(key);
  });
  return next;
}

// ── DB helpers ──
const insertChatStmt = db.query<ChatRow, [string, string, string]>(
  "INSERT INTO chats (id, project_id, title, source) VALUES (?, ?, ?, 'telegram') RETURNING *",
);

const getChatStmt = db.query<ChatRow, [string]>(
  "SELECT * FROM chats WHERE id = ?",
);

const insertMsgStmt = db.query<void, [string, string, string, string, string]>(
  "INSERT OR REPLACE INTO messages (id, project_id, chat_id, role, content) VALUES (?, ?, ?, ?, ?)",
);

const getMessagesStmt = db.query<MessageRow, [string]>(
  "SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC",
);

const touchChatStmt = db.query<void, [string]>(
  "UPDATE chats SET updated_at = datetime('now') WHERE id = ?",
);

// ── Credential helpers ──
const CRED_KEY = (pid: string) => `projects/${pid}/credentials/telegram-bot.json`;

interface BotCredential {
  botToken: string;
  botUsername: string;
  botId: number;
  botFirstName?: string;
  allowedUserIds?: string[];
}

async function readBotCredential(projectId: string): Promise<BotCredential | null> {
  try {
    const raw = await s3.file(CRED_KEY(projectId)).text();
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function getBotToken(projectId: string): Promise<string | null> {
  const info = await readBotCredential(projectId);
  return info?.botToken ?? null;
}

// ── Shared update handler (used by both webhook and polling) ──

export async function processIncomingUpdate(projectId: string, update: TelegramUpdate): Promise<void> {
  const message = update.message;
  if (!message) return;

  const cred = await readBotCredential(projectId);
  if (!cred) return;

  const telegramChatId = String(message.chat.id);
  const telegramUserId = String(message.from?.id ?? "");
  const chatType = message.chat.type;
  const text = message.text;
  const photo = message.photo;
  const caption = message.caption;
  const chatTitle = message.chat.title || message.chat.first_name || "Telegram Chat";

  if (!text && !photo) {
    // Non-text, non-photo message — tell user
    await sendTelegramText(cred.botToken, telegramChatId, "I can only process text and photo messages for now.");
    return;
  }

  // Allowlist check
  const allowed = cred.allowedUserIds;
  if (allowed && allowed.length > 0 && !allowed.includes(telegramUserId)) {
    tgLog.info("telegram user not in allowlist", { projectId, telegramUserId });
    await sendTelegramText(cred.botToken, telegramChatId, "Sorry, you're not authorized to use this bot.");
    return;
  }

  // In groups: only respond to @mentions or replies to bot
  const messageText = text || caption || "";
  if (chatType === "group" || chatType === "supergroup") {
    const isReplyToBot = message.reply_to_message?.from?.id === cred.botId;
    const isMention = cred.botUsername && messageText.includes(`@${cred.botUsername}`);
    if (!isReplyToBot && !isMention) return;
  }

  // Handle /new command — create a fresh conversation
  if (messageText.trim() === "/new") {
    const newChatId = createTelegramChat(projectId, chatTitle);
    upsertTelegramBinding(projectId, telegramChatId, newChatId, chatTitle);
    await sendTelegramText(cred.botToken, telegramChatId, "Started a new conversation.");
    tgLog.info("new conversation via /new", { projectId, telegramChatId, newChatId });
    return;
  }

  // Download photo if present
  let imageData: { base64: string; mediaType: string } | null = null;
  if (photo && photo.length > 0) {
    // Last element is the highest resolution
    const bestPhoto = photo[photo.length - 1]!;
    const buffer = await downloadTelegramFile(cred.botToken, bestPhoto.file_id);
    if (buffer) {
      try {
        const image = await Jimp.read(buffer);
        if (image.width > 1024) {
          image.resize({ w: 1024 });
        }
        const resized = await image.getBuffer("image/jpeg", { quality: 80 });
        imageData = { base64: resized.toString("base64"), mediaType: "image/jpeg" };
      } catch {
        // If resize fails, use original
        imageData = { base64: buffer.toString("base64"), mediaType: "image/jpeg" };
      }
    }
  }

  const userText = text || caption || (imageData ? "What's in this image?" : "");
  const lockKey = `${projectId}:${telegramChatId}`;
  withChatLock(lockKey, () => processIncomingMessage(projectId, telegramChatId, userText, chatTitle, imageData));
}

// ── Webhook handler (unauthenticated — verified by secret) ──

export async function handleTelegramWebhook(request: Request): Promise<Response> {
  // Always return 200 to prevent Telegram retries
  try {
    // Verify secret
    const secretHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (!WEBHOOK_SECRET || secretHeader !== WEBHOOK_SECRET) {
      tgLog.warn("webhook secret mismatch");
      return new Response("OK", { status: 200 });
    }

    const { projectId } = (request as Request & { params: { projectId: string } }).params;
    const update = await request.json() as TelegramUpdate;

    await processIncomingUpdate(projectId, update);

    return new Response("OK", { status: 200 });
  } catch (err) {
    tgLog.error("webhook error", err);
    return new Response("OK", { status: 200 });
  }
}

async function processIncomingMessage(
  projectId: string,
  telegramChatId: string,
  text: string,
  chatTitle: string,
  imageData?: { base64: string; mediaType: string } | null,
): Promise<void> {
  let botToken: string | null = null;
  try {
    botToken = await getBotToken(projectId);
    if (!botToken) {
      tgLog.warn("no bot token for project", { projectId });
      return;
    }

    const project = getProjectById(projectId);
    if (!project) {
      tgLog.warn("project not found", { projectId });
      return;
    }

    // Look up or create binding + chat
    let binding = getTelegramBinding(projectId, telegramChatId);
    let chatId: string;

    if (binding?.chat_id) {
      // Verify chat still exists
      const chat = getChatStmt.get(binding.chat_id);
      if (chat) {
        chatId = chat.id;
      } else {
        // Chat was deleted, create new one
        chatId = createTelegramChat(projectId, chatTitle);
        binding = upsertTelegramBinding(projectId, telegramChatId, chatId, chatTitle);
      }
    } else {
      chatId = createTelegramChat(projectId, chatTitle);
      binding = upsertTelegramBinding(projectId, telegramChatId, chatId, chatTitle);
    }

    // Load message history as ModelMessage[] with proper tool call/result reconstruction
    const dbMessages = getMessagesStmt.all(chatId);
    const messages: ModelMessage[] = [];
    const preActivateToolNames: string[] = [];

    for (const m of dbMessages) {
      let parsed: any;
      try {
        parsed = JSON.parse(m.content);
      } catch {
        // Plain string content
        messages.push({ role: m.role as "user" | "assistant", content: m.content });
        continue;
      }

      if (!parsed.parts) {
        // Legacy format without parts
        messages.push({ role: m.role as "user" | "assistant", content: parsed.content ?? m.content });
        continue;
      }

      const parts: any[] = parsed.parts;

      if (m.role === "user") {
        const textContent = parts
          .filter((p: any) => p.type === "text")
          .map((p: any) => p.text)
          .join("\n");
        messages.push({ role: "user", content: textContent });
        continue;
      }

      // Assistant message — separate tool parts from text parts
      const toolCallParts: any[] = [];
      const toolResultParts: any[] = [];
      const textParts: string[] = [];

      for (const part of parts) {
        if (typeof part.type === "string" && part.type.startsWith("tool-")) {
          const toolName = part.type.slice(5);
          preActivateToolNames.push(toolName);

          toolCallParts.push({
            type: "tool-call" as const,
            toolCallId: part.toolCallId,
            toolName,
            input: part.input ?? {},
          });

          if (part.output !== undefined) {
            const outputStr = typeof part.output === "string" ? part.output : JSON.stringify(part.output);
            toolResultParts.push({
              type: "tool-result" as const,
              toolCallId: part.toolCallId,
              toolName,
              output: { type: "text" as const, value: outputStr },
            });
          }
        } else if (part.type === "text" && part.text) {
          textParts.push(part.text);
        }
      }

      if (toolCallParts.length > 0) {
        // Assistant message with tool calls
        const assistantContent: any[] = [...toolCallParts];
        if (textParts.length > 0) {
          assistantContent.unshift({ type: "text", text: textParts.join("\n") });
        }
        messages.push({ role: "assistant", content: assistantContent });

        // Tool results as a separate tool message
        if (toolResultParts.length > 0) {
          messages.push({ role: "tool", content: toolResultParts });
        }
      } else {
        // Text-only assistant message
        messages.push({ role: "assistant", content: textParts.join("\n") || "" });
      }
    }

    // Add the new user message (with optional image)
    if (imageData) {
      const contentParts: any[] = [
        { type: "image", image: imageData.base64, mimeType: imageData.mediaType },
      ];
      if (text) contentParts.push({ type: "text", text });
      messages.push({ role: "user", content: contentParts });
    } else {
      messages.push({ role: "user", content: text });
    }

    // Persist user message
    const userMsgId = generateId();
    const userParts: any[] = [{ type: "text" as const, text }];
    if (imageData) userParts.unshift({ type: "image" as const, hasImage: true });
    const userMessage = {
      id: userMsgId,
      role: "user" as const,
      parts: userParts,
    };
    insertMsgStmt.run(userMsgId, projectId, chatId, "user", JSON.stringify(userMessage));

    // Run agent (non-streaming)
    tgLog.info("running agent for telegram message", { projectId, chatId, telegramChatId });

    const agent = await createAgent(project, {
      context: "chat",
      preActivateTools: preActivateToolNames.length > 0 ? preActivateToolNames : undefined,
    });
    const result = await agent.generate({ messages });

    const responseText = result.text || "Sorry, I couldn't generate a response.";

    // Build full parts array from result steps (preserving tool calls)
    const assistantParts: any[] = [];
    for (const step of result.steps) {
      for (const tc of step.toolCalls) {
        const toolName = tc.toolName;
        // Find matching result
        const tr = step.toolResults.find((r: any) => r.toolCallId === tc.toolCallId);
        assistantParts.push({
          type: `tool-${toolName}`,
          toolCallId: tc.toolCallId,
          state: "output-available",
          input: tc.input,
          output: tr?.output,
        });
      }
    }
    // Add final text
    if (responseText) {
      assistantParts.push({ type: "text" as const, text: responseText });
    }

    // Persist assistant message with full parts
    const assistantMsgId = generateId();
    const assistantMessage = {
      id: assistantMsgId,
      role: "assistant" as const,
      parts: assistantParts.length > 0 ? assistantParts : [{ type: "text" as const, text: responseText }],
    };
    insertMsgStmt.run(assistantMsgId, projectId, chatId, "assistant", JSON.stringify(assistantMessage));
    touchChatStmt.run(chatId);

    // Send response to Telegram with markdown→HTML conversion
    try {
      await sendTelegramHtml(botToken, telegramChatId, responseText);
    } catch (err) {
      if (err instanceof Error && err.message.includes("blocked")) {
        if (binding) disableTelegramBinding(binding.id);
      }
      throw err;
    }

    tgLog.info("telegram message processed", { projectId, chatId, telegramChatId, responseLength: responseText.length });
  } catch (err) {
    tgLog.error("failed to process telegram message", err, { projectId, telegramChatId });

    // Send error feedback to user
    if (botToken) {
      try {
        await sendTelegramText(botToken, telegramChatId, "Sorry, something went wrong. Please try again.");
      } catch {
        // Best-effort — don't throw on feedback failure
      }
    }
  }
}

function createTelegramChat(projectId: string, title: string): string {
  const chatId = generateId();
  insertChatStmt.get(chatId, projectId, `Telegram: ${title}`)!;
  return chatId;
}

// ── Management routes (authenticated) ──

export async function handleTelegramSetup(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId } = (request as Request & { params: { projectId: string } }).params;
    verifyProjectAccess(projectId, userId);

    const body: any = await request.json();
    const botToken = body.botToken;
    if (!botToken || typeof botToken !== "string") {
      return Response.json({ error: "botToken is required" }, { status: 400, headers: corsHeaders });
    }

    // Verify the token by calling getMe
    const botInfo = await getTelegramBotInfo(botToken);
    if (!botInfo) {
      return Response.json({ error: "Invalid bot token" }, { status: 400, headers: corsHeaders });
    }

    // Preserve existing allowedUserIds if re-connecting (max 1 user per project)
    const existing = await readBotCredential(projectId);
    const allowedUserIds = (body.allowedUserIds ?? existing?.allowedUserIds ?? []).slice(0, 1);

    // Store credential in S3
    await writeToS3(
      `projects/${projectId}/credentials/telegram-bot.json`,
      JSON.stringify({
        botToken,
        botUsername: botInfo.username,
        botId: botInfo.id,
        botFirstName: botInfo.firstName,
        allowedUserIds,
      }),
    );

    // Register webhook or start polling
    if (!WEBHOOK_BASE_URL) {
      tgLog.info("no TELEGRAM_WEBHOOK_BASE_URL, starting polling", { projectId });
      await startPollingForProject(projectId, botToken, processIncomingUpdate);
    } else {
      const webhookUrl = `${WEBHOOK_BASE_URL}/api/telegram/webhook/${projectId}`;
      const result = await setTelegramWebhook(botToken, webhookUrl, WEBHOOK_SECRET);
      if (!result.ok) {
        return Response.json(
          { error: `Failed to register webhook: ${result.description}` },
          { status: 500, headers: corsHeaders },
        );
      }
    }

    tgLog.info("telegram setup complete", { projectId, botUsername: botInfo.username });

    return Response.json(
      { connected: true, botUsername: botInfo.username },
      { status: 200, headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleTelegramTeardown(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId } = (request as Request & { params: { projectId: string } }).params;
    verifyProjectAccess(projectId, userId);

    const botToken = await getBotToken(projectId);
    if (botToken) {
      await deleteTelegramWebhook(botToken);
    }

    // Stop polling if active
    stopPollingForProject(projectId);

    // Remove credential
    try {
      await deleteFromS3(`projects/${projectId}/credentials/telegram-bot.json`);
    } catch {
      // May not exist
    }

    // Remove bindings
    deleteTelegramBindingsByProject(projectId);

    tgLog.info("telegram teardown complete", { projectId });

    return Response.json(
      { success: true },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleTelegramStatus(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId } = (request as Request & { params: { projectId: string } }).params;
    verifyProjectAccess(projectId, userId);

    const cred = await readBotCredential(projectId);

    return Response.json(
      {
        connected: !!cred,
        botUsername: cred?.botUsername ?? null,
        allowedUserIds: cred?.allowedUserIds ?? [],
      },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleUpdateTelegramAllowlist(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId } = (request as Request & { params: { projectId: string } }).params;
    verifyProjectAccess(projectId, userId);

    const body: any = await request.json();
    const allowedUserIds = body.allowedUserIds;
    if (!Array.isArray(allowedUserIds) || !allowedUserIds.every((id: unknown) => typeof id === "string")) {
      return Response.json({ error: "allowedUserIds must be an array of strings" }, { status: 400, headers: corsHeaders });
    }
    if (allowedUserIds.length > 1) {
      return Response.json({ error: "Only one allowed user per project" }, { status: 400, headers: corsHeaders });
    }

    const cred = await readBotCredential(projectId);
    if (!cred) {
      return Response.json({ error: "No Telegram bot configured" }, { status: 400, headers: corsHeaders });
    }

    // Update credential with new allowlist
    await writeToS3(
      CRED_KEY(projectId),
      JSON.stringify({ ...cred, allowedUserIds }),
    );

    tgLog.info("telegram allowlist updated", { projectId, count: allowedUserIds.length });

    return Response.json(
      { allowedUserIds },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleListTelegramBindings(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId } = (request as Request & { params: { projectId: string } }).params;
    verifyProjectAccess(projectId, userId);

    const bindings = getTelegramBindingsByProject(projectId);

    return Response.json(
      {
        bindings: bindings.map((b) => ({
          id: b.id,
          telegramChatId: b.telegram_chat_id,
          chatTitle: b.chat_title,
          enabled: b.enabled === 1,
          createdAt: b.created_at,
        })),
      },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}
