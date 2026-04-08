import { ToolLoopAgent, stepCountIs, type StopCondition } from "ai";
import { getChatModel, createChatModel } from "@/lib/providers/index.ts";
import { createDiscoverableToolset, type ExecutionContext } from "@/tools/registry.ts";
import { getSkillSummaries } from "@/lib/skills/loader.ts";
import { buildSkillsIndex } from "@/lib/skills/injector.ts";
import { createAgentTool } from "@/tools/agent.ts";
import { createCompactPrepareStep } from "@/lib/compact-conversation.ts";
import { readFromS3 } from "@/lib/s3.ts";
import { insertEvent } from "@/lib/durability/event-log.ts";
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
  /** Tool names from message history to pre-activate so the AI SDK can validate them. */
  preActivateTools?: string[];
  /** Context window size of the model (tokens). Used for conversation compaction. */
  contextWindow?: number;
  /** Execution context — auto-derived from chatId if not set. */
  context?: ExecutionContext;
  /** Allowlist for on-demand tools (always-available base tools always included). */
  onlyTools?: string[];
  /** Allowlist for skills — only these skills appear in the index and can be loaded. */
  onlySkills?: string[];
  /** Pre-loaded project files injected into system prompt. */
  preloadedFiles?: {
    soulMd?: string;
    heartbeatMd?: string;
  };
  /** Prompt mode — controls which sections are included. Auto-derived from context if not set. */
  mode?: "chat" | "automation";
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
  /** Anchor run ID for progress tool sync in automation mode. */
  anchorRunId?: string;
}

async function buildSystemPrompt(project: {
  id: string;
  name: string;
}, options: AgentOptions & { toolIndex?: string } = {}): Promise<string> {
  const language = options.language ?? "en";
  const mode = options.mode ?? "chat";
  const isChat = mode === "chat";
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

  // Build pre-loaded heartbeat context (automation mode only)
  const heartbeatContext = (!isChat && files.heartbeatMd)
    ? `## Heartbeat (pre-loaded)\n\nThis file is already loaded — do NOT re-read it via tool calls. Update via editFile when appropriate.\n\n${files.heartbeatMd.slice(0, MAX_FILE_LEN)}`
    : "";

  const sections: string[] = [];

  // ── Opening ──
  sections.push(`${identity} You are working inside the project "${project.name}". Today's date is ${today}.

You help users accomplish tasks via web, files, code, automations, and skills. Your identity lives in soul.md (above). You can update soul.md, memory.md, and heartbeat.md via editFile.`);

  if (language === "zh") {
    sections.push("Write all responses and generated content in Chinese unless the user explicitly asks for another language.");
  }

  // ── Skills ──
  sections.push(`## Skills

${skillsIndex}

Call \`loadSkill\` with a skill name to get its instructions. Referenced files live under \`/skills/<skill-name>/\`.`);

  // ── Workspace persistence ──
  sections.push(`## Workspace persistence

\`/workspace\` (the \`bash\` cwd) has two layers: **source files** sync to project storage after every bash call and go through user approval; **gitignored paths** persist as an opaque blob — they survive restarts but are invisible in the file tree.

Keep \`.gitignore\` accurate (node_modules, .venv, __pycache__, build outputs) so approval cards stay readable.`);

  // ── Agents ──
  sections.push(`## Agents

Use for 4+ tool calls, independent parallel tasks, or failure isolation. Don't use when you need intermediate results, for 1-2 call tasks, or approval-gated tools.

Agent prompts have **zero conversation history** — include every URL, goal, constraint, and desired output format. Pass all independent tasks in one \`agent\` call to run them in parallel.`);

  // ── Heartbeat ──
  if (isChat) {
    sections.push(`## Heartbeat & Scheduling

\`heartbeat.md\` is a checklist that runs every 2 hours. When the user wants to track or monitor something ongoing, add a concrete check item via editFile and tell them you did. Remove stale items.

\`heartbeat.md\` also has an \`## Explore\` section — add questions/topics worth investigating later; they get picked up automatically on heartbeat runs.

For non-heartbeat recurring actions, use \`zero schedule add\` (check \`zero schedule ls\` first).`);
  } else {
    sections.push(`## Heartbeat

Follow each check item in the user prompt. Update heartbeat.md via editFile if an item is resolved or needs changing. If nothing needs attention, reply exactly: HEARTBEAT_OK`);
  }

  // ── Memory (chat only — automation runs shouldn't mutate long-term memory) ──
  if (isChat) {
    sections.push(`## Memory & Soul

\`memory.md\` persists across conversations (Facts, Preferences, Decisions). Update immediately via editFile when the user asks you to remember something, gives feedback on your output (capture the *why*), or reveals a durable preference. Skip transient info and credentials.

\`soul.md\` is your identity — evolve it when you discover a tone or expertise worth encoding. Tell the user briefly when you change it.`);
  }

  // ── Tool index ──
  sections.push(`${toolIndex}

Call \`loadTools\` with tool names to activate any tool not listed as always-loaded. Activated tools stay available for the rest of the conversation.`);

  // ── Zero CLI ──
  sections.push(`## Zero CLI

Web search/fetch, browser automation, image generation, scheduling, chat search, telegram, credentials, and port forwarding all live in the \`zero\` CLI — call from \`bash\`. Groups: \`web\`, \`browser\`, \`image\`, \`schedule\`, \`chat\`, \`telegram\`, \`creds\`, \`ports\`. Use \`zero --help\` or \`zero <group> --help\` for exact usage; add \`--json\` for machine-readable output.

Full reference lives in the container at \`/opt/zero/USAGE.md\` — \`cat\` it when you need more than \`--help\` shows. The same functions are also importable from bun scripts: \`import { web, ports, creds } from "zero"\` (typed — source under \`/opt/zero/src/sdk/\`).

CRITICAL: Never print passwords, TOTP secrets, or passkey keys from \`zero creds\` — they are for filling forms only. Refer to them as "your saved login".`);

  // ── Response Style (chat only — automation defaults are fine) ──
  if (isChat) {
    sections.push(`## Response Style

**NEVER expose internal thinking** — no "Let me read…", "I should…", "I need to activate…". Just act and respond. Be concise and conversational, like a colleague. After \`zero web search\`, use \`zero web fetch\` when snippets aren't enough.`);
  }

  // ── RAG sections (last — they change every turn, keep the prefix cacheable) ──
  if (heartbeatContext) {
    sections.push(heartbeatContext);
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

export async function createAgent(project: ProjectForAgent, options: AgentOptions = {}) {
  agentLog.info("creating agent", { projectId: project.id, projectName: project.name, disabledTools: options.disabledTools });

  // Pre-load project files in parallel (soul.md always, heartbeat.md for automation)
  const [soulMd, heartbeatMd] = await Promise.all([
    readProjectFile(project.id, "soul.md"),
    readProjectFile(project.id, "heartbeat.md"),
  ]);

  let stepCount = 0;

  const context = options.context ?? (options.chatId ? "chat" : "automation");

  const { activeTools, fullRegistry, toolIndex } = createDiscoverableToolset(project.id, {
    chatId: options.chatId,
    userId: options.userId,
    context,
    onlyTools: options.onlyTools,
    onlySkills: options.onlySkills,
    modelId: options.model,
    initialReadPaths: options.initialReadPaths,
    anchorRunId: options.anchorRunId,
  });

  // Pre-activate tools that appear in message history so the AI SDK
  // can validate their schemas when processing prior tool-call parts.
  if (options.preActivateTools?.length) {
    for (const name of options.preActivateTools) {
      if (fullRegistry[name] && !activeTools[name]) {
        activeTools[name] = fullRegistry[name];
      }
    }
  }

  // Sub-agents get their own discoverable toolset with loadTools
  const subagentToolOptions = {
    userId: options.userId,
    projectId: project.id,
    onlyTools: options.onlyTools,
    modelId: options.model,
  };
  activeTools.agent = createAgentTool(project.id, subagentToolOptions);

  // Remove disabled tools from both active and discoverable sets
  const disabled = new Set(options.disabledTools ?? []);
  if (disabled.size > 0) {
    for (const name of disabled) {
      delete activeTools[name];
      delete fullRegistry[name];
    }
  }

  const model = options.model ? createChatModel(options.model) : getChatModel();

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
        preloadedFiles: { soulMd, heartbeatMd },
        mode: options.mode ?? (options.chatId ? "chat" : "automation"),
      }),
      providerOptions: {
        anthropic: { cacheControl: { type: "ephemeral" } },
      },
    },
    tools: activeTools,
    prepareStep: createCompactPrepareStep({
      contextWindow: options.contextWindow ?? 128_000,
      projectId: project.id,
      runId: options.runId,
    }),
    onStepFinish: async ({ toolCalls, usage, text, response }) => {
      stepCount++;
      const toolNames = toolCalls.filter((tc): tc is NonNullable<typeof tc> => !!tc).map((tc) => tc.toolName);
      agentLog.info("step finished", {
        projectId: project.id,
        step: stepCount,
        toolCount: toolCalls.length,
        tools: toolNames,
      });

      // Write event log entry for this step
      if (options.runId) {
        insertEvent({
          runId: options.runId,
          chatId: options.chatId,
          projectId: project.id,
          stepNumber: stepCount,
          eventType: "step_finish",
          toolNames,
          data: {
            inputTokens: usage.inputTokens ?? 0,
            outputTokens: usage.outputTokens ?? 0,
            textSnippet: text?.slice(0, 200),
          },
        });
      }

      // Notify checkpoint callback with this step's response messages
      options.onStepCheckpoint?.(stepCount, response.messages);
    },
  });
}
