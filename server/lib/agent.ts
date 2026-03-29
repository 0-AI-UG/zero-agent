import { ToolLoopAgent, stepCountIs } from "ai";
import { chatModel, createChatModel } from "@/lib/openrouter.ts";
import { createDiscoverableToolset, type ExecutionContext } from "@/tools/registry.ts";
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
    projectMd?: string;
    memoryMd?: string;
    heartbeatMd?: string;
  };
  /** Prompt mode — controls which sections are included. Auto-derived from context if not set. */
  mode?: "chat" | "automation";
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

  // Build pre-loaded project context section
  const projectContextParts: string[] = [];
  if (files.projectMd) {
    projectContextParts.push(`### Project\n${files.projectMd.slice(0, MAX_FILE_LEN)}`);
  }
  if (files.memoryMd) {
    projectContextParts.push(`### Memory\n${files.memoryMd.slice(0, MAX_FILE_LEN)}`);
  }
  if (files.heartbeatMd) {
    projectContextParts.push(`### Heartbeat\n${files.heartbeatMd.slice(0, MAX_FILE_LEN)}`);
  }
  const projectContext = projectContextParts.length > 0
    ? `## Project Context (pre-loaded)\n\nThese files are already loaded — do NOT re-read them via tool calls. You can still update them via editFile during the conversation.\n\n${projectContextParts.join("\n\n")}`
    : "";

  const sections: string[] = [];

  // ── Opening ──
  sections.push(`${identity} You are working inside the project "${project.name}".

Today's date is ${today}.

You help users accomplish tasks by browsing the web, managing files, running code, scheduling automations, and using skills. Project knowledge files (soul.md, project.md, memory.md, heartbeat.md) are pre-loaded below — do NOT re-read them. Update them via editFile when appropriate.`);

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

  // ── Project Knowledge (both modes) ──
  if (isChat) {
    sections.push(`## Project Knowledge

\`project.md\` captures the project's goals, context, key decisions, and important details.

**Update proactively.** When the user shares details about what the project is, who it's for, key constraints, technologies, or goals — update project.md immediately via editFile. This file should be a living document that gives future conversations full context.

**Update when:** user describes the project purpose, audience, or goals; key decisions are made; important context is shared that would help in future conversations. **Don't update:** transient task details, conversation-specific instructions, or information already captured in memory.md.

**First conversation:** When project.md is still empty (contains "No project information yet"), prioritize learning about the project. Ask clarifying questions, then update project.md and soul.md based on what you learn. Make the user feel like the project is being set up through natural conversation.`);
  } else {
    sections.push(`## Project Knowledge

\`project.md\` captures the project's goals, context, and key decisions. Update it via editFile if you discover important new information during this task.`);
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

**Don't update:** transient info, one-time requests, small talk, credentials, or things already in project.md.`);
  } else {
    sections.push(`## Memory

\`memory.md\` persists across conversations. If this task reveals something worth remembering (a significant finding, a changed status, a lesson learned), update memory.md via editFile.`);
  }

  // ── Project context (both modes — automation needs project context to do its job) ──
  if (projectContext) {
    sections.push(projectContext);
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

  // ── Todos (chat only — automation tasks are already planned) ──
  if (isChat) {
    sections.push(`## Todos — Planning Before Execution

For tasks with 3+ steps, create ALL todos upfront before starting work. Each todo = one actionable step (1-3 tool calls), ordered by dependency, with success criteria in the description.

**Lifecycle:** create todos → mark \`in_progress\` → do work → mark \`completed\`. Add new todos if scope grows. Mark \`failed\` with reason if blocked, then continue.

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

Login credentials are stored as JSON files in \`credentials/\`. Use \`readFile("credentials/{domain}.json")\` to check for saved credentials. Use \`loadPasskey\` (via \`loadTools\`) for passkey-based sign-in.

Never log or display passwords or passkey keys. Refer to credentials as "your saved login".`);

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

  // Pre-load all project files in parallel
  const [soulMd, projectMd, memoryMd, heartbeatMd] = await Promise.all([
    readProjectFile(project.id, "soul.md"),
    readProjectFile(project.id, "project.md"),
    readProjectFile(project.id, "memory.md"),
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
    codeExecutionEnabled: project.code_execution_enabled === 1,
    modelId: options.model,
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

  const model = options.model ? createChatModel(options.model) : chatModel;

  return new ToolLoopAgent({
    model,
    stopWhen: stepCountIs(100),
    instructions: {
      role: "system",
      content: await buildSystemPrompt({
        id: project.id,
        name: project.name,
      }, {
        ...options,
        toolIndex,
        preloadedFiles: { soulMd, projectMd, memoryMd, heartbeatMd },
        mode: options.mode ?? (options.chatId ? "chat" : "automation"),
      }),
      providerOptions: {
        anthropic: { cacheControl: { type: "ephemeral" } },
      },
    },
    tools: activeTools,
    prepareStep: createCompactPrepareStep(options.contextWindow ?? 128_000),
    onStepFinish: async ({ toolCalls }) => {
      stepCount++;
      const toolNames = toolCalls.filter((tc): tc is NonNullable<typeof tc> => !!tc).map((tc) => tc.toolName);
      agentLog.info("step finished", {
        projectId: project.id,
        step: stepCount,
        toolCount: toolCalls.length,
        tools: toolNames,
      });
    },
  });
}
