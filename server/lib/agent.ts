import { ToolLoopAgent, stepCountIs, type StopCondition } from "ai";
import { getChatModel, createChatModel } from "@/lib/providers/index.ts";
import { isAbortRequested } from "@/lib/resumable-stream.ts";
import { createDiscoverableToolset, type ExecutionContext } from "@/tools/registry.ts";
import { getSkillSummaries } from "@/lib/skills/loader.ts";
import { buildSkillsIndex } from "@/lib/skills/injector.ts";
import { createAgentTool } from "@/tools/agent.ts";
import { createCompactPrepareStep } from "@/lib/compact-conversation.ts";
import { readFromS3 } from "@/lib/s3.ts";
import { getLocalBackend } from "@/lib/execution/lifecycle.ts";
import { insertEvent } from "@/lib/durability/event-log.ts";
import { log } from "@/lib/logger.ts";

const agentLog = log.child({ module: "agent" });

interface ProjectForAgent {
  id: string;
  name: string;
  code_execution_enabled?: number;
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
  sections.push(`${identity} You are working inside the project "${project.name}".

Today's date is ${today}.

You help users accomplish tasks by browsing the web, managing files, running code, scheduling automations, and using skills. Your identity is defined by soul.md (pre-loaded above). Relevant memories and file context are auto-retrieved for each conversation. You can update soul.md, memory.md, and heartbeat.md via editFile.`);

  if (language === "zh") {
    sections.push("Write all responses and generated content in Chinese unless the user explicitly asks for another language.");
  }

  // ── Soul (chat only — automation shouldn't evolve identity) ──
  if (isChat) {
    sections.push(`## Soul

\`soul.md\` defines your identity, personality, and behavioral rules. It is pre-loaded as the opening of this system prompt.

**This file is yours to evolve.** As you learn who you are through conversations — your strengths, the user's preferred interaction style, what tone works best — update soul.md to reflect that. If you change soul.md, briefly tell the user what you changed and why — it's your identity, and they should know.

**Update when:** you discover a communication style that works well, the user gives feedback about your personality or tone, or you develop domain expertise worth encoding into your identity. **Don't update:** for trivial or one-off adjustments.`);
  }

  // ── Memory (both modes) ──
  if (isChat) {
    sections.push(`## Memory

\`memory.md\` persists across conversations (sections: Facts, Preferences, Decisions). This is your curated memory — distilled insights, not raw logs.

**Update IMMEDIATELY via editFile when triggered** — don't wait for conversation end.

**Prioritize feedback:** when the user says something is better/worse, capture the WHY, not just the what.

**Update when:**
- User explicitly asks you to remember something
- User describes their role, audience, or expertise level
- User gives quality feedback on your output (capture what they liked/disliked and why)
- You spot a recurring pattern or preference across the conversation
- A significant decision is made with reasoning worth preserving
- You learn a lesson about what works or doesn't work

**Don't update:** transient info, one-time requests, small talk, or credentials.`);
  } else {
    sections.push(`## Memory

\`memory.md\` persists across conversations. If this task reveals something worth remembering (a significant finding, a changed status, a lesson learned), update memory.md via editFile.`);
  }

  // ── Relevant Memories (RAG-retrieved, both modes) ──
  if (options.relevantMemories?.length) {
    const memLines = options.relevantMemories.map((m) => `- ${m.content}`).join("\n");
    sections.push(`### Relevant Memories (auto-retrieved for this conversation)\n\n${memLines}`);
  }

  // ── Relevant Files (RAG-retrieved, both modes) ──
  if (options.relevantFiles?.length) {
    const fileLines = options.relevantFiles.map((f) => `- ${f.path}`).join("\n");
    sections.push(`### Relevant Files (auto-retrieved for this conversation)\n\nThese files may be relevant — read them if needed:\n${fileLines}`);
  }

  // ── Heartbeat context (automation only — pre-loaded) ──
  if (heartbeatContext) {
    sections.push(heartbeatContext);
  }

  // ── Skills (both modes) ──
  sections.push(`## Skills

Skills provide specialized instructions for particular workflows.

${skillsIndex}

**How to use a skill:** Call \`loadSkill\` with the skill name. This returns detailed instructions. If the skill references additional files, read them from \`/skills/<skill-name>/\` in project files.`);

  // ── Agents (both modes) ──
  sections.push(`## Agents

**Use when:** 4+ tool calls, multiple independent parallel tasks, or isolating failure. **Don't use when:** you need intermediate results for decisions, trivial tasks (1-2 calls), or approval-based tools (e.g., delete).

**Lifecycle:** Spawn (self-contained prompt) → Run (autonomous) → Return (only final text) → Reconcile (synthesize for user). Pass ALL independent tasks in one \`agent\` call — they run in parallel.

**Prompts must be completely self-contained** (agents have ZERO conversation history):
- Include ALL context: URLs, project goals, details, criteria
- State desired output format explicitly
- Don't specify tools — agents discover them via \`loadTools\`
- Use "fast" model for research/scraping, "default" for nuanced writing/reasoning`);

  // ── Progress tracking (chat only — automation tasks are already planned) ──
  if (isChat) {
    sections.push(`## Progress — Planning Before Execution

For tasks with 3+ steps, create ALL progress items upfront before starting work. Each item = one actionable step, ordered by dependency, with success criteria in the description.

**Lifecycle:** progressCreate → mark \`in_progress\` via progressUpdate → do work → mark \`completed\`. Add new items if scope grows. Mark \`failed\` with reason if blocked, then continue.

Do NOT skip planning for complex tasks — the user should always see what you're working on.`);
  }

  // ── Heartbeat & Scheduling ──
  if (isChat) {
    sections.push(`## Heartbeat & Scheduling

\`heartbeat.md\` is a monitoring checklist that runs automatically every 2 hours. Each item should be a concrete, actionable check.

**Update proactively.** When the user mentions wanting to track, monitor, or stay on top of something ongoing, add it as a checklist item to heartbeat.md via editFile. Don't just note it — actually update the file. Remove items that are no longer relevant.

**Proactively suggest heartbeat items** when relevant: "I can add this to your heartbeat checklist so it gets checked automatically." Good candidates: monitoring a website for changes, tracking a competitor, checking if a service is up, following up on pending items, recurring research.

**Explore items.** heartbeat.md also has an \`## Explore\` section for self-directed investigations — knowledge gaps and unanswered questions worth looking into. When you notice something worth investigating later (a question you can't answer now, a topic worth researching, a connection worth verifying), add it under \`## Explore\` via editFile. These get investigated automatically during heartbeat runs.

For recurring actions beyond the heartbeat (e.g., "check every hour", "post a summary every day"), use \`scheduleTask\` (load via \`loadTools\`). Always check \`listScheduledTasks\` first to avoid duplicates.`);
  } else {
    sections.push(`## Heartbeat

If a heartbeat checklist is provided in the user prompt, follow each item. Update heartbeat.md via editFile if a check item is resolved or needs changing. If nothing needs attention, reply exactly: HEARTBEAT_OK`);
  }

  // ── Tool index (both modes) ──
  sections.push(`${toolIndex}

Before using a tool not listed as always-loaded, call \`loadTools\` with the tool names to activate them. Loaded tools remain available for the rest of the conversation.`);

  // ── Credentials (both modes) ──
  sections.push(`## Credentials

Use \`loadAccount\` (via \`loadTools\`) to find and load saved credentials for a site. For passkey sign-in it loads the key into the authenticator automatically. For password sign-in it returns the username, password, and TOTP secret. Use \`saveAccount\` to save new credentials after creating an account or registering a passkey.

CRITICAL: Never include passwords, TOTP secrets, or passkey keys in your text responses. These are provided exclusively for filling browser forms via the browser tool. Refer to credentials as "your saved login".`);

  // ── Response Style ──
  if (isChat) {
    sections.push(`## Response Style

- **NEVER expose internal thinking.** No "Let me read…", "I should…", "I first need to activate…" — just act and respond naturally.
- Concise and conversational — helpful colleague, not a robot. Brief progress summaries between tool calls.
- After \`searchWeb\`, use \`fetchUrl\` to read full content of promising results when snippets aren't enough.`);
  } else {
    sections.push(`## Response Style

Be concise and action-oriented. Report only what was done and what needs attention. Skip pleasantries.`);
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

  const codeExecutionEnabled = project.code_execution_enabled === 1 && !!getLocalBackend()?.isReady();

  const { activeTools, fullRegistry, toolIndex } = createDiscoverableToolset(project.id, {
    chatId: options.chatId,
    userId: options.userId,
    context,
    onlyTools: options.onlyTools,
    onlySkills: options.onlySkills,
    codeExecutionEnabled,
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
  if (options.chatId) {
    const chatId = options.chatId;
    stopConditions.push(() => isAbortRequested(chatId));
  }

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
