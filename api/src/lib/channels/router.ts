import { generateId } from "ai";
import { createSalesAgent } from "@/lib/agent.ts";
import { db } from "@/db/index.ts";
import { touchChat, updateChat } from "@/db/queries/chats.ts";
import { getChannelById, getOrCreateChannelChat, insertChannelMessage } from "@/db/queries/channels.ts";
import { getProjectById } from "@/db/queries/projects.ts";
import { log } from "@/lib/logger.ts";
import type { ChannelAdapter, InboundMessage } from "./types.ts";

const routerLog = log.child({ module: "channel-router" });

const insertMsg = db.query<void, [string, string, string, string, string]>(
  "INSERT OR REPLACE INTO messages (id, project_id, chat_id, role, content) VALUES (?, ?, ?, ?, ?)",
);

const recentMessagesStmt = db.query<{ role: string; content: string }, [string, number]>(
  "SELECT role, content FROM messages WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?",
);

const CONTEXT_MESSAGES = 20;

/**
 * Build a UIMessage-compatible parts array from agent.generate() result.
 * Includes tool invocation parts so they render in the web chat view.
 */
function buildAssistantParts(result: any): any[] {
  const parts: any[] = [];

  if (result.steps?.length) {
    for (const step of result.steps) {
      // Add tool call parts
      if (step.toolCalls?.length) {
        for (let i = 0; i < step.toolCalls.length; i++) {
          const tc = step.toolCalls[i];
          const tr = step.toolResults?.[i];
          parts.push({
            type: `tool-${tc.toolName}`,
            toolInvocation: {
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              args: tc.args,
              state: tr ? "output-available" : "input-available",
              ...(tr ? { output: tr.result } : {}),
            },
          });
        }
      }
      // Add text from this step
      if (step.text?.trim()) {
        parts.push({ type: "text" as const, text: step.text });
      }
    }
  }

  // Fallback: if no parts were generated from steps, use result.text
  if (parts.length === 0 || !parts.some((p) => p.type === "text")) {
    const text = result.text || "Sorry, I couldn't generate a response.";
    if (!parts.some((p) => p.type === "text" && p.text === text)) {
      parts.push({ type: "text" as const, text });
    }
  }

  return parts;
}

export function createMessageHandler(channelId: string, adapter: ChannelAdapter) {
  return async (msg: InboundMessage): Promise<void> => {
    const channel = getChannelById(channelId);
    if (!channel || !channel.enabled) {
      routerLog.warn("channel disabled or missing", { channelId });
      return;
    }

    const project = getProjectById(channel.project_id);
    if (!project) {
      routerLog.warn("project not found for channel", { channelId, projectId: channel.project_id });
      return;
    }

    // Allowlist check
    const allowedSenders: string[] = JSON.parse(channel.allowed_senders || "[]");
    if (allowedSenders.length > 0 && !allowedSenders.includes(msg.senderIdentifier) && !allowedSenders.includes(msg.externalChatId)) {
      routerLog.info("rejected unauthorized sender", { channelId, sender: msg.senderIdentifier });
      return;
    }

    // Find or create chat for this external conversation
    const chat = getOrCreateChannelChat(channel.project_id, channelId, msg.externalChatId, channel.platform);

    routerLog.info("processing inbound message", {
      channelId,
      platform: msg.platform,
      externalChatId: msg.externalChatId,
      chatId: chat.id,
    });

    // Persist inbound message
    const userMsgId = generateId();
    const userMessage = {
      id: userMsgId,
      role: "user" as const,
      parts: [{ type: "text" as const, text: msg.text }],
    };
    insertMsg.run(userMsgId, channel.project_id, chat.id, "user", JSON.stringify(userMessage));

    // Record in channel_messages
    insertChannelMessage({
      channelId,
      projectId: channel.project_id,
      chatId: chat.id,
      externalChatId: msg.externalChatId,
      senderIdentifier: msg.senderIdentifier,
      direction: "inbound",
      contentText: msg.text,
    });

    // Load conversation context
    const recentRows = recentMessagesStmt.all(chat.id, CONTEXT_MESSAGES).reverse();
    const history = recentRows.map((row) => {
      try {
        const parsed = JSON.parse(row.content);
        const text = parsed.parts?.[0]?.text ?? row.content;
        return { role: row.role as "user" | "assistant", content: text };
      } catch {
        return { role: row.role as "user" | "assistant", content: row.content };
      }
    });

    // Build prompt with conversation history
    const contextLines = history.slice(0, -1).map((m) => `${m.role}: ${m.content}`).join("\n");
    const prompt = contextLines
      ? `Previous conversation:\n${contextLines}\n\nUser message: ${msg.text}`
      : msg.text;

    try {
      const agent = await createSalesAgent(project, {});
      const result = await agent.generate({ prompt });

      // Build full UIMessage parts including tool invocations
      const assistantParts = buildAssistantParts(result);
      const responseText = result.text || assistantParts.find((p: any) => p.type === "text")?.text || "Sorry, I couldn't generate a response.";

      // Persist assistant response with full parts (tool calls + text)
      const assistantMsgId = generateId();
      const assistantMessage = {
        id: assistantMsgId,
        role: "assistant" as const,
        parts: assistantParts,
      };
      insertMsg.run(assistantMsgId, channel.project_id, chat.id, "assistant", JSON.stringify(assistantMessage));

      // Record outbound in channel_messages
      insertChannelMessage({
        channelId,
        projectId: channel.project_id,
        chatId: chat.id,
        externalChatId: msg.externalChatId,
        senderIdentifier: "bot",
        direction: "outbound",
        contentText: responseText,
      });

      touchChat(chat.id);

      // Auto-title: if still "New Chat", derive from first user message
      if (chat.title === "New Chat") {
        const title = msg.text.length > 50 ? msg.text.slice(0, 50) + "..." : msg.text;
        updateChat(chat.id, { title });
      }

      // Update last_message_at on channel
      db.run("UPDATE channels SET last_message_at = datetime('now') WHERE id = ?", [channelId]);

      // Send response back via adapter (text only, no tool UI)
      await adapter.send(msg.externalChatId, { text: responseText });

      routerLog.info("responded to channel message", {
        channelId,
        chatId: chat.id,
        responseLength: responseText.length,
        toolCalls: assistantParts.filter((p: any) => p.type !== "text").length,
      });
    } catch (err) {
      routerLog.error("failed to process channel message", err);
      try {
        await adapter.send(msg.externalChatId, {
          text: "Sorry, I encountered an error processing your message. Please try again.",
        });
      } catch (sendErr) {
        routerLog.error("failed to send error message", sendErr);
      }
    }
  };
}
