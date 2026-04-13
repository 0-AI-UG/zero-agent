/**
 * Plan mode tool - `finishPlanning` blocks the agent until the user
 * chooses to implement, alter, or start a new chat with the plan.
 *
 * Uses the pending-responses system so the blocking semantics, timeout,
 * and multi-channel resolution all come for free.
 */
import { generateId, tool } from "ai";
import type { UIMessage } from "ai";
import { z } from "zod";
import { readFromS3 } from "@/lib/s3.ts";
import { createPendingGroup } from "@/lib/pending-responses/store.ts";
import { NOTIFICATION_KINDS } from "@/lib/notifications/kinds.ts";
import { broadcastToProject } from "@/lib/http/ws.ts";
import { log } from "@/lib/utils/logger.ts";
import { requestAbort, createAbortController, clearAbortController } from "@/lib/http/resumable-stream.ts";
import { insertChat } from "@/db/queries/chats.ts";
import { saveChatMessages } from "@/db/queries/messages.ts";
import { getProjectById } from "@/db/queries/projects.ts";
import { events } from "@/lib/scheduling/events.ts";
import { runAgentStepStreaming } from "@/lib/agent-step/index.ts";

const planLog = log.child({ module: "planning" });

const PLAN_REVIEW_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour

export function createPlanningTools(
  projectId: string,
  options: { chatId: string; userId: string; projectName: string },
) {
  return {
    finishPlanning: tool({
      description:
        "Call when the plan is ready for user review. Blocks until the user decides to implement or alter the plan.",
      inputSchema: z.object({
        summary: z
          .string()
          .describe("Brief 1-2 sentence summary of the plan"),
        planFilePath: z
          .string()
          .describe("Path to the plan file (e.g. plans/feature-x.md)"),
      }),
      execute: async ({ summary, planFilePath }) => {
        // Read plan content from file if a path was provided.
        let planContent = "";
        if (planFilePath) {
          try {
            planContent = await readFromS3(`projects/${projectId}/${planFilePath}`);
          } catch {
            planLog.warn("could not read plan file", { planFilePath, projectId });
          }
        }

        const created = createPendingGroup({
          targetUserIds: [options.userId],
          projectId,
          kind: NOTIFICATION_KINDS.PLAN_REVIEW,
          requesterKind: "agent",
          requesterContext: {
            userId: options.userId,
            projectId,
            chatId: options.chatId,
            planFilePath,
          },
          prompt: summary,
          payload: {
            planFilePath,
            summary,
            chatId: options.chatId,
          },
          timeoutMs: PLAN_REVIEW_TIMEOUT_MS,
        });

        const responseId = created.rows[0]!.id;

        broadcastToProject(projectId, {
          type: "plan.ready",
          chatId: options.chatId,
          planFilePath,
          planContent,
          summary,
          responseId,
        });

        planLog.info("plan review pending", {
          projectId,
          chatId: options.chatId,
          planFilePath,
          responseId,
        });

        const resolution = await created.handle.wait();
        const responseText = resolution.text;

        if (responseText.startsWith("alter:")) {
          return {
            decision: "alter" as const,
            feedback: responseText.slice(6),
            planFilePath,
            planContent,
          };
        }

        // "implement_new_chat" - create a new chat, insert the user message,
        // start a backend-driven streaming run, and tell the frontend to
        // navigate there. The frontend spectates the already-running stream.
        if (responseText === "implement_new_chat") {
          const newChat = insertChat(projectId, "Plan Implementation", options.userId);
          events.emit("chat.created", { chatId: newChat.id, projectId, title: newChat.title ?? "Plan Implementation" });

          // Insert the user message into the DB so the frontend sees it on load.
          const userMsgId = generateId();
          const userText = `Implement the plan at ${planFilePath}`;
          const userMessage: UIMessage = {
            id: userMsgId,
            role: "user",
            parts: [{ type: "text", text: userText }],

          };
          saveChatMessages(projectId, newChat.id, [
            { id: userMsgId, role: "user", content: JSON.stringify(userMessage) },
          ], options.userId);

          // Start the implementation stream in the background (fire-and-forget).
          // The frontend will spectate via resumeStream() after navigating.
          const project = getProjectById(projectId);
          if (project) {
            const streamId = generateId();
            const abortController = createAbortController(newChat.id);
            runAgentStepStreaming({
              project: { id: project.id, name: project.name },
              chatId: newChat.id,
              userId: options.userId,
              messages: [userMessage],
              abortSignal: abortController.signal,
              streamId,
              notifyAsUserId: "__plan_implement__",
              notifyAsUsername: "Plan implementation",
            }).then(async (response) => {
              if (response.body) {
                await response.body.pipeTo(new WritableStream());
              }
            }).catch((err) => {
              planLog.error("plan implementation stream failed", err, { chatId: newChat.id });
              clearAbortController(newChat.id);
            });
          }

          broadcastToProject(projectId, {
            type: "plan.new_chat_created",
            sourceChatId: options.chatId,
            newChatId: newChat.id,
          });

          // Don't abort the planning chat - let the agent finish its turn
          // naturally so the tool result is persisted. The agent will see
          // the decision and can respond accordingly.
          return {
            decision: "implement_new_chat" as const,
            newChatId: newChat.id,
            planFilePath,
            planContent,
          };
        }

        // "implement" - abort this stream, then tell the frontend to send
        // a fresh implementation message without plan mode.
        broadcastToProject(projectId, {
          type: "chat.autoSend",
          chatId: options.chatId,
          message: `Implement the plan at ${planFilePath}`,
        });
        requestAbort(options.chatId);

        return {
          decision: "implement" as const,
          planFilePath,
          planContent,
        };
      },
    }),
  };
}
