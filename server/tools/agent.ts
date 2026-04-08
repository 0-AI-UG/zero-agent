import { z } from "zod";
import { tool, ToolLoopAgent, stepCountIs } from "ai";
import { createDiscoverableToolset } from "@/tools/registry.ts";
import { getChatModel, getEnrichModel } from "@/lib/providers/index.ts";
import { getSkillSummaries } from "@/lib/skills/loader.ts";
import { buildSkillsIndex } from "@/lib/skills/injector.ts";
import { nanoid } from "nanoid";
import { log } from "@/lib/logger.ts";

const toolLog = log.child({ module: "tool:agent" });

// Structural exclusions beyond what the "subagent" context scope handles
const AGENT_EXCLUDED_TOOLS: string[] = [];

export interface AgentToolOptions {
  userId?: string;
  projectId?: string;
  onlyTools?: string[];
  modelId?: string;
}

export function createAgentTool(projectId: string, toolOptions: AgentToolOptions) {
  return tool({
    description:
      "Spawn one or more agents to handle tasks autonomously. Use for multi-step research, data processing, content creation, or any task that needs its own tool loop. When you have multiple independent tasks, pass them all to run in parallel. Each agent has loadTools and can discover any tools it needs. Agents cannot use approval-based tools (e.g. delete) — handle those in the main conversation instead.",
    inputSchema: z.object({
      tasks: z
        .array(
          z.object({
            prompt: z.string().describe("Task description for this agent. Be specific and self-contained — agents have no conversation history."),
            model: z
              .enum(["default", "fast"])
              .default("fast")
              .describe("'default' (main model) or 'fast' (Qwen). Use fast for research/scraping. IMPORTANT: tasks that need the browser tool MUST use 'default' — the fast model cannot handle the browser tool's input schema."),
          }),
        )
        .min(1)
        .max(5),
    }),
    execute: async function* ({ tasks }, { toolCallId }) {
      toolLog.info("spawn", { toolCallId, taskCount: tasks.length });

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
        // Each subagent gets its own discoverable toolset
        const { activeTools, toolIndex } = createDiscoverableToolset(projectId, {
          userId: toolOptions.userId,
          excludeTools: AGENT_EXCLUDED_TOOLS,
          context: "subagent",
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

        const subagentInstructions = `You are a sub-agent executing a specific task autonomously.

## Tools
Call \`loadTools\` with tool names before using them. Only file tools (readFile, writeFile, editFile, listFiles), loadSkill, and loadTools are available without loading. Load all the tools you need in a SINGLE \`loadTools\` call upfront.

${toolIndex}
${skillsIndex ? `\n## Skills\n${skillsIndex}\nCall \`loadSkill\` with a skill name to get platform-specific instructions.\n` : ""}
## Important
- You MUST end with a text summary of your findings/results. Never end on just a tool call.`;

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
