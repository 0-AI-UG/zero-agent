import { stepCountIs } from "ai";
import type { StopCondition, ToolSet } from "ai";
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
import { ensureBackend } from "@/lib/execution/lifecycle.ts";
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
   * Autonomous (non-interactive) run - propagates to tool construction for
   * autonomous-specific behaviour (no interactive prompts, etc.).
   */
  autonomous?: boolean;
  /** Plan mode - agent explores, writes a plan, then calls finishPlanning for user review. */
  planMode?: boolean;
}

/**
 * Handle returned by `createAgent`. A passive configuration bundle — the
 * entrypoints in `agent-step/index.ts` wire these fields into `streamText`
 * / `generateText` from the AI SDK.
 */
export interface AgentHandle {
  /** OpenRouter model ID. */
  model: string;
  /** System-prompt string. */
  systemPrompt: string;
  /** Tools keyed by name. */
  tools: ToolSet;
  /** Maximum number of agent loop steps. */
  maxSteps: number;
  /** Tool-loop stop conditions. */
  stopWhen: StopCondition<ToolSet>[];
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
}, options: AgentOptions = {}): Promise<string> {
  const language = options.language ?? "en";
  const today = new Date().toISOString().split("T")[0];
  let skillSummaries = await getSkillSummaries(project.id);
  if (options.onlySkills?.length) {
    const allowed = new Set(options.onlySkills);
    skillSummaries = skillSummaries.filter(s => allowed.has(s.name));
  }
  const skillsIndex = buildSkillsIndex(skillSummaries);
  const files = options.preloadedFiles ?? {};

  const MAX_FILE_LEN = 20_000;

  const sections: string[] = [];

  // Item 3: only push identity if soulMd is present; always push project-meta.
  if (files.soulMd) {
    sections.push(files.soulMd.slice(0, MAX_FILE_LEN));
  }
  sections.push(`Project: "${project.name}". Date: ${today}.`);

  if (language === "zh") {
    sections.push("Write all responses and generated content in Chinese unless the user explicitly asks for another language.");
  }

  if (skillsIndex) {
    sections.push(`## Skills\n\n${skillsIndex}`);
  }

  // Item 1: compressed zero CLI blurb.
  sections.push(`Use the \`zero\` CLI (via bash) or SDK (\`import { web, browser, llm, ... } from "zero"\`) for web, browser, images, scheduling, messaging, credentials, and LLM calls. Run \`zero --help\` for details.`);

  if (options.planMode) {
    sections.push(`## Plan Mode

Explore the code, then write a plan to \`plans/{descriptive-name}.md\` covering the summary, approach, files touched, and risks. Call \`finishPlanning\` with the path when ready. If the user asks for revisions with no specific feedback, ask what they want changed before revising. Do not implement yet.`);
  }

  // Item 2: drop "(auto-retrieved)" and "Read if needed:" nagging.
  if (options.relevantMemories?.length) {
    const memLines = options.relevantMemories.map((m) => `- ${m.content}`).join("\n");
    sections.push(`## Memories\n\n${memLines}`);
  }
  if (options.relevantFiles?.length) {
    const fileLines = options.relevantFiles.map((f) => `- ${f.path}`).join("\n");
    sections.push(`## Files\n\n${fileLines}`);
  }

  return sections.join("\n\n");
}

async function readProjectFile(projectId: string, filename: string): Promise<string | undefined> {
  try {
    const backend = await ensureBackend();
    if (!backend) return undefined;
    const buf = await backend.readFile(projectId, filename);
    return buf?.toString("utf-8");
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

  const baseTools = createToolset(project.id, {
    chatId: options.chatId,
    userId: options.userId,
    onlyTools: options.onlyTools,
    onlySkills: options.onlySkills,
    modelId: options.model,
    runId: options.runId,
  });

  const tools: ToolSet = { ...baseTools };

  // Plan mode - append finishPlanning tool.
  if (options.planMode && options.chatId && options.userId) {
    const planningTools = createPlanningTools(project.id, {
      chatId: options.chatId,
      userId: options.userId,
      projectName: project.name,
    });
    Object.assign(tools, planningTools);
  }

  // Sub-agent spawner.
  const agentTool = createAgentTool(project.id, {
    userId: options.userId,
    projectId: project.id,
    projectName: project.name,
    onlyTools: options.onlyTools,
    modelId: options.model,
    chatId: options.chatId,
  });
  Object.assign(tools, agentTool);

  // Remove disabled tools.
  const disabled = new Set(options.disabledTools ?? []);
  if (disabled.size) {
    for (const name of disabled) {
      delete tools[name];
    }
  }

  const model = options.fast
    ? getEnrichModelId()
    : options.model
      ? resolveChatModelId(options.model)
      : getChatModelId();

  const maxSteps = options.maxSteps ?? 100;
  const stopConditions = [stepCountIs(maxSteps)];

  const systemPrompt = await buildSystemPrompt(
    { id: project.id, name: project.name },
    {
      ...options,
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
    tools,
    maxSteps,
    stopWhen: stopConditions,
    prepareStep,
    onStepFinish,
    options,
    project,
  };
}
