import { ToolLoopAgent, stepCountIs, type StopCondition } from "ai";
import { getChatModel, createChatModel, getEnrichModel } from "@/lib/providers/index.ts";
import { createToolset } from "@/tools/registry.ts";
import { getSkillSummaries } from "@/lib/skills/loader.ts";
import { buildSkillsIndex } from "@/lib/skills/injector.ts";
import { createAgentTool } from "@/tools/agent.ts";
import { createCompactPrepareStep } from "@/lib/compact-conversation.ts";
import { readFromS3 } from "@/lib/s3.ts";
import { log } from "@/lib/logger.ts";

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
  /** Allowlist for skills — only these skills appear in the index and can be loaded. */
  onlySkills?: string[];
  /** Pre-loaded project files injected into system prompt. */
  preloadedFiles?: {
    soulMd?: string;
  };
  /** File paths already read/written in prior turns — seeds the read guard so the agent doesn't need to re-read. */
  initialReadPaths?: string[];
  /** Semantically relevant memory entries retrieved via RAG for this conversation. */
  relevantMemories?: { content: string; score: number }[];
  /** Semantically relevant files retrieved via RAG for this conversation (paths only). */
  relevantFiles?: { path: string }[];
  /** Unique ID for this agent run — used for event logging and checkpointing. */
  runId?: string;
  /** Callback fired after each step with the current step number and response messages — used for checkpointing. */
  onStepCheckpoint?: (stepNumber: number, responseMessages: Array<{ role: string; content: unknown }>) => void;
  /** Maximum number of agent steps before stopping. Defaults to 100. */
  maxSteps?: number;
  /** Use the fast/enrich model instead of the default chat model. Overrides `model`. */
  fast?: boolean;
  /**
   * Autonomous (non-interactive) run — propagates to tool construction so
   * the bash sync-approval flow fans out to every project member instead of
   * just the triggering user.
   */
  autonomous?: boolean;
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

  // ── Opening ──
  sections.push(`${identity} Project: "${project.name}". Date: ${today}.`);

  if (language === "zh") {
    sections.push("Write all responses and generated content in Chinese unless the user explicitly asks for another language.");
  }

  // ── Skills ──
  if (skillsIndex) {
    sections.push(`## Skills\n\n${skillsIndex}`);
  }

  // ── Tool index ──
  if (toolIndex) {
    sections.push(toolIndex);
  }

  // ── Response Style ──
  sections.push(`Never expose internal thinking. Just act and respond concisely. Never print credentials — use shell substitution.`);

  // ── RAG sections (last — they change every turn, keep the prefix cacheable) ──
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

export async function createAgent(project: ProjectForAgent, options: AgentOptions = {}) {
  agentLog.info("creating agent", { projectId: project.id, projectName: project.name, disabledTools: options.disabledTools });

  const soulMd = await readProjectFile(project.id, "SOUL.md");

  let stepCount = 0;

  const { tools, toolIndex } = createToolset(project.id, {
    chatId: options.chatId,
    userId: options.userId,
    onlyTools: options.onlyTools,
    onlySkills: options.onlySkills,
    modelId: options.model,
    initialReadPaths: options.initialReadPaths,
    runId: options.runId,
    autonomous: options.autonomous,
  });

  // Sub-agent spawner — also gets the full toolset via createToolset internally
  tools.agent = createAgentTool(project.id, {
    userId: options.userId,
    projectId: project.id,
    projectName: project.name,
    onlyTools: options.onlyTools,
    modelId: options.model,
    chatId: options.chatId,
  });

  // Remove disabled tools
  for (const name of options.disabledTools ?? []) {
    delete tools[name];
  }

  const model = options.fast
    ? getEnrichModel()
    : options.model ? createChatModel(options.model) : getChatModel();

  const stopConditions: StopCondition<any>[] = [
    stepCountIs(options.maxSteps ?? 100),
  ];

  return new ToolLoopAgent({
    model,
    stopWhen: stopConditions,
    instructions: {
      role: "system",
      content: await buildSystemPrompt({
        id: project.id,
        name: project.name,
      }, {
        ...options,
        toolIndex,
        preloadedFiles: { soulMd },
      }),
      providerOptions: {
        anthropic: { cacheControl: { type: "ephemeral" } },
      },
    },
    tools,
    prepareStep: createCompactPrepareStep({
      contextWindow: options.contextWindow ?? 128_000,
      projectId: project.id,
      runId: options.runId,
      chatId: options.chatId,
    }),
    onStepFinish: async ({ toolCalls, response }) => {
      stepCount++;
      const toolNames = toolCalls.filter((tc): tc is NonNullable<typeof tc> => !!tc).map((tc) => tc.toolName);
      agentLog.info("step finished", {
        projectId: project.id,
        step: stepCount,
        toolCount: toolCalls.length,
        tools: toolNames,
      });

      // Notify checkpoint callback with this step's response messages
      options.onStepCheckpoint?.(stepCount, response.messages);
    },
  });
}
