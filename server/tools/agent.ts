import { z } from "zod";
import { tool } from "@openrouter/sdk/lib/tool.js";
import { runAutonomousTask } from "@/lib/agent/autonomous-agent.ts";
import { runAgentStepBatch } from "@/lib/agent-step/index.ts";
import { events } from "@/lib/scheduling/events.ts";
import { registerBackgroundTask } from "@/lib/agent/background-task-store.ts";
import { nanoid } from "nanoid";
import { log } from "@/lib/utils/logger.ts";

const toolLog = log.child({ module: "tool:agent" });

/** Derive a short chat/task name from the first line of the task prompt. */
function deriveTaskName(prompt: string, fallbackIndex: number): string {
  const firstLine = prompt.split("\n", 1)[0]?.trim() ?? "";
  if (!firstLine) return `Background agent ${fallbackIndex + 1}`;
  return firstLine.length > 60 ? firstLine.slice(0, 57) + "…" : firstLine;
}

export interface AgentToolOptions {
  userId?: string;
  projectId?: string;
  projectName?: string;
  onlyTools?: string[];
  modelId?: string;
  chatId?: string;
}

export function createAgentTool(projectId: string, toolOptions: AgentToolOptions) {
  return tool({
    name: "agent",
    description:
      "Spawn agents for autonomous tasks. Pass multiple tasks to run in parallel. Set background=true for long-running work. Agents have no conversation history - make prompts self-contained.",
    inputSchema: z.object({
      background: z
        .boolean()
        .default(false)
        .describe(
          "Run in background (fire-and-forget). Returns immediately with a run ID. Use for long-running tasks where you don't need results inline.",
        ),
      tasks: z
        .array(
          z.object({
            prompt: z
              .string()
              .describe(
                "Task description for this agent. Be specific and self-contained - agents have no conversation history.",
              ),
            model: z
              .enum(["default", "fast"])
              .default("fast")
              .describe(
                "'default' (main model) or 'fast' (cheap model). Use fast for research/scraping. Tasks that need the browser tool MUST use 'default'.",
              ),
          }),
        )
        .min(1),
    }),
    execute: async ({ background, tasks }, ctx) => {
      const toolCallId = ctx?.toolCall?.callId;
      toolLog.info("spawn", { toolCallId, taskCount: tasks.length, background });

      // ── Background mode: fire-and-forget via runAutonomousTask ──
      if (background) {
        const projectName = toolOptions.projectName ?? projectId;
        const runs = tasks.map((task, index) => {
          const runId = nanoid();
          const taskName = deriveTaskName(task.prompt, index);

          runAutonomousTask(
            { id: projectId, name: projectName },
            taskName,
            task.prompt,
            {
              userId: toolOptions.userId,
              skipHeartbeat: true,
              fast: task.model === "fast",
              onlyTools: toolOptions.onlyTools,
            },
          )
            .then((result) => {
              toolLog.info("background agent completed", {
                runId,
                chatId: result.chatId,
                taskName,
              });
              events.emit("background.completed", {
                runId,
                projectId,
                chatId: result.chatId,
                taskName,
                summary: result.summary,
              });
            })
            .catch((err) => {
              const errorMsg = err instanceof Error ? err.message : String(err);
              const chatId = (err as any)?.chatId ?? "";
              toolLog.error("background agent failed", err, { runId, taskName });
              events.emit("background.failed", {
                runId,
                projectId,
                chatId,
                taskName,
                error: errorMsg,
              });
            });

          if (toolOptions.chatId) {
            registerBackgroundTask(toolOptions.chatId, { runId, taskName, projectId });
          }

          return { index, runId, taskName };
        });

        return {
          status: "background" as const,
          message: `Started ${runs.length} background task(s). The user will be notified when they complete.`,
          runs,
        };
      }

      // ── Inline mode: run subagents in parallel via runAgentStepBatch ──
      const projectName = toolOptions.projectName ?? projectId;
      const completedResults: Array<{
        index: number;
        status: "fulfilled" | "rejected";
        text?: string;
        steps?: number;
        error?: string;
      }> = [];

      const promises = tasks.map(async (task, index) => {
        try {
          const result = await runAgentStepBatch({
            project: { id: projectId, name: projectName },
            chatId: toolOptions.chatId ?? `subagent-${nanoid()}`,
            userId: toolOptions.userId,
            onlyTools: toolOptions.onlyTools,
            fast: task.model === "fast",
            prompt: task.prompt,
            taskName: deriveTaskName(task.prompt, index),
            maxSteps: 50,
          });
          const r = {
            index,
            status: "fulfilled" as const,
            text: result.text,
            steps: result.steps.length,
          };
          completedResults.push(r);
          return r;
        } catch (err) {
          toolLog.error("subagent spawn failed", err, { index });
          const r = {
            index,
            status: "rejected" as const,
            error: err instanceof Error ? err.message : String(err),
          };
          completedResults.push(r);
          return r;
        }
      });

      await Promise.all(promises);

      toolLog.info("spawn complete", {
        toolCallId,
        results: completedResults.map((r) => ({ index: r.index, status: r.status })),
      });

      return { status: "done" as const, results: completedResults };
    },
  });
}
