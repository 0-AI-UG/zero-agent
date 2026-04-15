import { stepCountIs } from "@openrouter/sdk/lib/stop-conditions.js";
import type { StopCondition, Tool } from "@openrouter/sdk/lib/tool-types.js";
import {
  getChatModelId,
  resolveChatModelId,
  getEnrichModelId,
} from "@/lib/providers/index.ts";
import { createToolset } from "@/tools/registry.ts";
import { getSkillSummaries } from "@/lib/skills/loader.ts";
import { buildSkillsIndex } from "@/lib/skills/injector.ts";
import { createAgentTool } from "@/tools/agent.ts";
import {
  createCompactPrepareStep,
  type PrepareStepFn,
} from "@/lib/conversation/compact-conversation.ts";
import { createPlanningTools } from "@/tools/planning.ts";
import { readFromS3 } from "@/lib/s3.ts";
import { log } from "@/lib/utils/logger.ts";

const agentLog = log.child({ module: "agent" });

interface ProjectForAgent {
  id: string;
  name: string;
}

export interface AgentOptions {
  /** OpenRouter model ID to use for chat. Falls back to the default chatModel if not set. */
  model?: string;
  language?: "en" | "zh";
  disabledTools?: string[];
  chatId?: string;
  userId?: string;
  /** Context window size of the model (tokens). Used for conversation compaction. */
  contextWindow?: number;
  /** Allowlist for tools (core file/bash/skill tools always included). */
  onlyTools?: string[];
  /** Allowlist for skills - only these skills appear in the index and can be loaded. */
  onlySkills?: string[];
  /** Pre-loaded project files injected into system prompt. */
  preloadedFiles?: {
    soulMd?: string;
  };
  /** File paths already read/written in prior turns - seeds the read guard so the agent doesn't need to re-read. */
  initialReadPaths?: string[];
  /** Semantically relevant memory entries retrieved via RAG for this conversation. */
  relevantMemories?: { content: string; score: number }[];
  /** Semantically relevant files retrieved via RAG for this conversation (paths only). */
  relevantFiles?: { path: string }[];
  /** Unique ID for this agent run - used for event logging and checkpointing. */
  runId?: string;
  /** Callback fired after each step with the current step number and response messages - used for checkpointing. */
  onStepCheckpoint?: (stepNumber: number, responseMessages: Array<{ role: string; content: unknown }>) => void;
  /** Maximum number of agent steps before stopping. Defaults to 100. */
  maxSteps?: number;
  /** Use the fast/enrich model instead of the default chat model. Overrides `model`. */
  fast?: boolean;
  /**
   * Autonomous (non-interactive) run - propagates to tool construction so
   * the bash sync-approval flow fans out to every project member instead of
   * just the triggering user.
   */
  autonomous?: boolean;
  /** Plan mode - agent explores, writes a plan, then calls finishPlanning for user review. */
  planMode?: boolean;
}

/**
 * Handle returned by `createAgent`. A passive configuration bundle — the
 * entrypoints in `agent-step/index.ts` wire these fields into `callModel`
 * from `@openrouter/sdk`.
 */
export interface AgentHandle {
  /** OpenRouter model ID. */
  model: string;
  /** System-prompt string. */
  systemPrompt: string;
  /** Tools in the order they're exposed to the model. */
  tools: readonly Tool[];
  /** Tool-loop stop conditions. */
  stopWhen: ReadonlyArray<StopCondition<readonly Tool[]>>;
  /** Per-turn message/system rewriter (compaction, orphan patching, background notifications). */
  prepareStep: PrepareStepFn;
  /** Fired after each step with the step number and cumulative response messages. */
  onStepFinish: (stepNumber: number, responseMessages: Array<{ role: string; content: unknown }>) => void;
  /** Copy of the input options for downstream consumers that want to re-instantiate tools. */
  options: AgentOptions;
  /** Project reference (used by sub-agent spawner). */
  project: ProjectForAgent;
}

async function buildSystemPrompt(project: {
  id: string;
  name: string;
}, options: AgentOptions & { toolIndex?: string } = {}): Promise<string> {
  const language = options.language ?? "en";
  const today = new Date().toISOString().split("T")[0];
  let skillSummaries = await getSkillSummaries(project.id);
  if (options.onlySkills?.length) {
    const allowed = new Set(options.onlySkills);
    skillSummaries = skillSummaries.filter(s => allowed.has(s.name));
  }
  const skillsIndex = buildSkillsIndex(skillSummaries);
  const toolIndex = options.toolIndex ?? "";
  const files = options.preloadedFiles ?? {};

  const MAX_FILE_LEN = 20_000;

  const identity = files.soulMd
    ? files.soulMd.slice(0, MAX_FILE_LEN)
    : `You are an AI assistant.`;

  const sections: string[] = [];

  sections.push(`${identity} Project: "${project.name}". Date: ${today}.`);

  if (language === "zh") {
    sections.push("Write all responses and generated content in Chinese unless the user explicitly asks for another language.");
  }

  if (skillsIndex) {
    sections.push(`## Skills\n\n${skillsIndex}`);
  }

  if (toolIndex) {
    sections.push(toolIndex);
  }

  sections.push(`Use the \`zero\` CLI (via bash) or SDK (installed in global node_modules: \`import { web, browser, llm, ... } from "zero"\` in bun scripts) for web search, fetching pages, browser automation, image generation, scheduling, messaging the user, credentials, port forwarding, and LLM calls. Run \`zero --help\` for usage. Don't install other tools when zero already covers it.`);

  sections.push(`Never expose internal thinking. Just act and respond concisely. Never print credentials - use shell substitution.`);

  if (options.planMode) {
    sections.push(`## Plan Mode

You are in planning mode. Design a thorough plan before any implementation.

1. **Explore**: Use subagents to read files, understand architecture, gather context.
2. **Ask questions**: If anything is unclear, ask the user before proceeding.
3. **Write a plan**: Use writeFile to save the plan at \`plans/{descriptive-name}.md\` covering:
   - Summary of what will be built
   - Step-by-step implementation approach
   - Files to create or modify
   - Potential risks or trade-offs
4. **Finish**: Call finishPlanning with the plan file path and a brief summary. The user will then choose to implement or alter the plan.

If the user asks to revise the plan and no specific feedback is provided (empty feedback), ask the user what they'd like changed before making revisions. Once you understand their feedback, revise the plan file and call finishPlanning again.

Do NOT implement anything. Focus only on exploration and planning.`);
  }

  if (options.relevantMemories?.length) {
    const memLines = options.relevantMemories.map((m) => `- ${m.content}`).join("\n");
    sections.push(`## Relevant Memories (auto-retrieved)\n\n${memLines}`);
  }
  if (options.relevantFiles?.length) {
    const fileLines = options.relevantFiles.map((f) => `- ${f.path}`).join("\n");
    sections.push(`## Relevant Files (auto-retrieved)\n\nRead if needed:\n${fileLines}`);
  }

  return sections.join("\n\n");
}

async function readProjectFile(projectId: string, filename: string): Promise<string | undefined> {
  try {
    return await readFromS3(`projects/${projectId}/${filename}`);
  } catch {
    return undefined;
  }
}

export async function createAgent(
  project: ProjectForAgent,
  options: AgentOptions = {},
): Promise<AgentHandle> {
  agentLog.info("creating agent", {
    projectId: project.id,
    projectName: project.name,
    disabledTools: options.disabledTools,
  });

  const soulMd = await readProjectFile(project.id, "SOUL.md");

  let stepCount = 0;

  const { tools: baseTools, toolIndex } = createToolset(project.id, {
    chatId: options.chatId,
    userId: options.userId,
    onlyTools: options.onlyTools,
    onlySkills: options.onlySkills,
    modelId: options.model,
    initialReadPaths: options.initialReadPaths,
    runId: options.runId,
    autonomous: options.autonomous,
  });

  const tools: Tool[] = [...baseTools];

  // Plan mode - append finishPlanning tool.
  if (options.planMode && options.chatId && options.userId) {
    const planningTools = createPlanningTools(project.id, {
      chatId: options.chatId,
      userId: options.userId,
      projectName: project.name,
    });
    for (const t of planningTools) tools.push(t as unknown as Tool);
  }

  // Sub-agent spawner.
  tools.push(
    createAgentTool(project.id, {
      userId: options.userId,
      projectId: project.id,
      projectName: project.name,
      onlyTools: options.onlyTools,
      modelId: options.model,
      chatId: options.chatId,
    }) as unknown as Tool,
  );

  // Remove disabled tools.
  const disabled = new Set(options.disabledTools ?? []);
  const filtered = disabled.size
    ? tools.filter((t) => !disabled.has(t.function.name))
    : tools;

  const model = options.fast
    ? getEnrichModelId()
    : options.model
      ? resolveChatModelId(options.model)
      : getChatModelId();

  const stopConditions = [stepCountIs(options.maxSteps ?? 100)];

  const systemPrompt = await buildSystemPrompt(
    { id: project.id, name: project.name },
    {
      ...options,
      toolIndex,
      preloadedFiles: { soulMd },
    },
  );

  const prepareStep = createCompactPrepareStep({
    contextWindow: options.contextWindow ?? 128_000,
    projectId: project.id,
    runId: options.runId,
    chatId: options.chatId,
  });

  const onStepFinish: AgentHandle["onStepFinish"] = (
    stepNumber,
    responseMessages,
  ) => {
    stepCount = stepNumber;
    const m = process.memoryUsage();
    agentLog.info("step finished", {
      projectId: project.id,
      step: stepCount,
      responseMessageCount: responseMessages.length,
      heapMB: (m.heapUsed / 1048576).toFixed(0),
      extMB: (m.external / 1048576).toFixed(0),
    });
    options.onStepCheckpoint?.(stepNumber, responseMessages);
  };

  return {
    model,
    systemPrompt,
    tools: filtered,
    stopWhen: stopConditions as ReadonlyArray<StopCondition<readonly Tool[]>>,
    prepareStep,
    onStepFinish,
    options,
    project,
  };
}
