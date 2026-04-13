import { z } from "zod";
import { tool, ToolLoopAgent, stepCountIs } from "ai";
import { createToolset } from "@/tools/registry.ts";
import { getChatModel, getEnrichModel } from "@/lib/providers/index.ts";
import { getSkillSummaries } from "@/lib/skills/loader.ts";
import { buildSkillsIndex } from "@/lib/skills/injector.ts";
import { runAutonomousTask } from "@/lib/agent/autonomous-agent.ts";
import { events } from "@/lib/scheduling/events.ts";
import { registerBackgroundTask } from "@/lib/agent/background-task-store.ts";
import { nanoid } from "nanoid";
import { log } from "@/lib/utils/logger.ts";

const toolLog = log.child({ module: "tool:agent" });

// Tools subagents don't get (on top of the `agent` spawner itself, which is
// not injected here - only by the main-agent path in server/lib/agent.ts).
const AGENT_EXCLUDED_TOOLS: string[] = [];

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
    description:
      "Spawn agents for autonomous tasks. Pass multiple tasks to run in parallel. Set background=true for long-running work. Agents have no conversation history - make prompts self-contained.",
    inputSchema: z.object({
      background: z
        .boolean()
        .default(false)
        .describe("Run in background (fire-and-forget). Returns immediately with a run ID. Use for long-running tasks where you don't need results inline."),
      tasks: z
        .array(
          z.object({
            prompt: z.string().describe("Task description for this agent. Be specific and self-contained - agents have no conversation history."),
            model: z
              .enum(["default", "fast"])
              .default("fast")
              .describe("'default' (main model) or 'fast' (Qwen). Use fast for research/scraping. IMPORTANT: tasks that need the browser tool MUST use 'default' - the fast model cannot handle the browser tool's input schema."),
          }),
        )
        .min(1),
    }),
    execute: async function* ({ background, tasks }, { toolCallId }) {
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
              // Delegated tasks carry a specific goal - don't inherit the
              // project's HEARTBEAT.md checklist on top of it.
              skipHeartbeat: true,
              // Honor the parent's `model` hint (default vs fast).
              fast: task.model === "fast",
              // Inherit the parent's tool/skill allowlist so a restricted
              // parent (e.g. scheduled task with onlyTools) can't escape the
              // restriction by spawning a background agent.
              onlyTools: toolOptions.onlyTools,
            },
          )
            .then((result) => {
              toolLog.info("background agent completed", { runId, chatId: result.chatId, taskName });
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

        yield {
          status: "background" as const,
          message: `Started ${runs.length} background task(s). The user will be notified when they complete.`,
          runs,
        };
        return;
      }

      yield {
        status: "running" as const,
        completed: 0,
        total: tasks.length,
        results: [] as Array<{ index: number; status: string }>,
      };

      const completedResults: Array<{ index: number; status: string; text?: string; steps?: number; error?: string }> = [];
      const progress = new Map<number, { index: number; step: number; currentTools?: string[]; lastText?: string }>();

      let resolveUpdate: (() => void) | null = null;

      const promises = tasks.map(async (task, index) => {
        // Each subagent gets its own toolset (no chatId → no progress tools;
        // no `agent` spawner → no recursive fan-out).
        const { tools: activeTools, toolIndex } = createToolset(projectId, {
          userId: toolOptions.userId,
          excludeTools: AGENT_EXCLUDED_TOOLS,
          onlyTools: toolOptions.onlyTools,
          modelId: toolOptions.modelId,
        });

        const selectedModel = task.model === "default" ? getChatModel() : getEnrichModel();
        let stepNum = 0;

        toolLog.info("subagent setup", {
          index,
          registryTools: Object.keys(activeTools),
          model: task.model,
        });

        // Build skills index for the subagent
        const skillSummaries = toolOptions.projectId ? await getSkillSummaries(toolOptions.projectId) : [];
        const skillsIndex = buildSkillsIndex(skillSummaries);

        const subagentInstructions = [
          toolIndex,
          skillsIndex ? `## Skills\n${skillsIndex}` : "",
          `End with a text summary of your results.`,
        ].filter(Boolean).join("\n\n");

        const agent = new ToolLoopAgent({
          model: selectedModel,
          stopWhen: stepCountIs(50),
          instructions: subagentInstructions,
          tools: activeTools,
          onStepFinish: async ({ toolCalls, toolResults, text, finishReason }) => {
            stepNum++;
            const toolNames = toolCalls?.map((tc: any) => tc.toolName) ?? [];
            const resultSummaries = toolResults?.map((tr: any) => {
              const r = tr.result;
              if (!r) return { tool: tr.toolName, result: "undefined" };
              if (r.error) return { tool: tr.toolName, error: r.error };
              // Truncate large results (snapshots, screenshots) for logging
              const type = r.type ?? "unknown";
              const summary: any = { tool: tr.toolName, type };
              if (type === "snapshot") summary.contentLength = r.content?.length ?? 0;
              else if (type === "screenshot") summary.base64Length = r.base64?.length ?? 0;
              else if (type === "done") summary.message = r.message;
              else summary.preview = JSON.stringify(r).slice(0, 200);
              return summary;
            }) ?? [];
            progress.set(index, {
              index,
              step: stepNum,
              currentTools: toolNames,
              lastText: text?.slice(0, 200),
            });
            if (resolveUpdate) resolveUpdate();
            toolLog.info("subagent step", {
              index,
              step: stepNum,
              finishReason,
              toolsCalled: toolNames,
              hasText: !!text,
              textLength: text?.length ?? 0,
              textPreview: text?.slice(0, 100) ?? "",
              toolResults: resultSummaries,
            });
          },
        });

        try {
          const result = await agent.generate({ prompt: task.prompt });

          // result.text only contains the last step's text.
          // If the last step was empty (e.g. model stopped after tool calls),
          // collect text from all steps so we don't lose earlier output.
          let text = result.text;
          if (!text && result.steps?.length) {
            text = result.steps
              .map((s: any) => s.text)
              .filter(Boolean)
              .join("\n");
          }

          toolLog.info("subagent finished", {
            index,
            steps: stepNum,
            finishReason: result.finishReason,
            hasText: !!text,
            textLength: text?.length ?? 0,
            lastStepTextLength: result.text?.length ?? 0,
            lastToolCalls: result.toolCalls?.map((tc: any) => tc.toolName) ?? [],
            totalSteps: result.steps?.length ?? 0,
          });
          const r = { index, status: "fulfilled" as const, text, steps: stepNum };
          completedResults.push(r);
          if (resolveUpdate) resolveUpdate();
          return r;
        } catch (err) {
          toolLog.error("spawn failed", err, { index });
          const r = { index, status: "rejected" as const, error: String(err) };
          completedResults.push(r);
          if (resolveUpdate) resolveUpdate();
          return r;
        }
      });

      // Yield progress as tasks complete
      let allDone = false;
      const allPromise = Promise.all(promises).then(() => {
        allDone = true;
        if (resolveUpdate) resolveUpdate();
      });

      while (!allDone) {
        await new Promise<void>((resolve) => {
          resolveUpdate = resolve;
        });
        resolveUpdate = null;

        if (!allDone) {
          const completedIndices = new Set(completedResults.map((r) => r.index));
          yield {
            status: "running" as const,
            completed: completedResults.length,
            total: tasks.length,
            results: completedResults.map((r) => ({
              index: r.index,
              status: r.status,
              text: r.text,
              error: r.error,
              steps: r.steps,
            })),
            progress: Array.from(progress.values()).filter((p) => !completedIndices.has(p.index)),
          };
        }
      }

      await allPromise;

      toolLog.info("spawn complete", {
        toolCallId,
        results: completedResults.map((r) => ({ index: r.index, status: r.status })),
      });

      yield { status: "done" as const, results: completedResults };
    },
  });
}
