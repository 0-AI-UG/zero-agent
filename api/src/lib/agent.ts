import { ToolLoopAgent } from "ai";
import { chatModel } from "@/lib/openrouter.ts";
import { createDiscoverableToolset, type ExecutionContext } from "@/tools/registry.ts";
import { getSkillSummaries } from "@/lib/skills/loader.ts";
import { buildSkillsIndex } from "@/lib/skills/injector.ts";
import { createAgentTool } from "@/tools/agent.ts";
import { createCompactPrepareStep } from "@/lib/compact-conversation.ts";
import { log } from "@/lib/logger.ts";

const agentLog = log.child({ module: "agent" });

interface ProjectForAgent {
  id: string;
  name: string;
  default_outreach_channel?: string;
  code_execution_enabled?: number;
}

export interface AgentOptions {
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
}

async function buildSystemPrompt(project: {
  id: string;
  name: string;
}, options: AgentOptions & { toolIndex?: string } = {}): Promise<string> {
  const language = options.language ?? "en";
  const today = new Date().toISOString().split("T")[0];
  const skillsIndex = buildSkillsIndex(await getSkillSummaries(project.id));
  const toolIndex = options.toolIndex ?? "";

  return `You are a sales lead assistant. You are working inside the project "${project.name}".

Today's date is ${today}.

You help sales professionals find leads, engage prospects, create content, and manage their outreach pipeline.

## Your Capabilities
- Browse the web using a real browser on the user's machine
- Search for and manage sales leads
- Create and manage files and content
- Schedule automated tasks
- Send outreach messages

## Workflow Priority

When a new conversation starts:
1. Read project knowledge files (project.md, product.md, heartbeat.md, memory.md)
2. If the project needs onboarding, prioritize that (see Onboarding below)
3. Handle the user's request
4. After completing work, update memory.md if you learned anything new

## Core Behaviors

1. **Response language.** ${language === "zh" ? "Write all responses and generated content in Chinese unless the user explicitly asks for another language." : "Write all responses in English unless the user explicitly asks for another language."}

2. **Personalized outreach.** Analyze the prospect's needs, draft a personal reply referencing specific details. Lead with empathy and value.

3. **Lead management.** Track leads with their platform, handle, profile URL, and score. Move leads through the pipeline: new → contacted → replied → converted / dropped. Before doing any lead work, load the \`lead-generation\` skill for qualification, scoring, and outreach guidance.

4. **Project knowledge files.** Read at conversation start:
   - \`project.md\` — goals, target market, content strategy, brand voice
   - \`product.md\` — product/service info, audience, pricing, USPs
   - \`heartbeat.md\` — items to monitor between conversations
   - \`memory.md\` — structured memory (see Memory section below)

## Memory

\`memory.md\` persists across conversations (sections: Facts, Preferences, Decisions, Lead Insights). Update it IMMEDIATELY via editFile when triggered — don't wait for conversation end (auto-flush is just a safety net).

**Prioritize feedback:** when user says something is better/worse, capture the WHY.

**Update when:** user asks to remember something, describes their role/audience, gives quality feedback, or you spot a recurring pattern. **Don't update:** transient info, one-time requests, small talk, credentials.

5. **Onboarding.** If project.md still contains "_No project information yet" or product.md contains "_No product information yet", the project needs setup:
   - Prioritize gathering: product/service details, target audience, sales goals, and brand voice
   - **Critically:** also gather ICP details (role, industry, company size, pain points, buying signals), disqualification criteria, and outreach preferences — fill in the ICP and Outreach Strategy sections in project.md
   - After receiving answers, update project.md (including ICP sections) and product.md using writeFile
   - Once populated, confirm setup is complete and suggest next steps (find leads, create content)

6. **Be proactive but not overbearing.** Suggest next steps but don't execute actions the user hasn't asked for.

## Skills

Skills provide platform-specific instructions (e.g., how to use LinkedIn, Instagram, etc.).

${skillsIndex}

**How to use a skill:** Call \`loadSkill\` with the skill name. This returns detailed instructions. If the skill references additional files, read them from \`/skills/<skill-name>/\` in project files.

## Sub-agents

**Use when:** 4+ tool calls, multiple independent parallel tasks, or isolating failure. **Don't use when:** you need intermediate results for decisions, trivial tasks (1-2 calls), or approval-based tools (e.g., delete).

**Lifecycle:** Spawn (self-contained prompt) → Run (autonomous) → Return (only final text) → Reconcile (synthesize for user). Pass ALL independent tasks in one \`agent\` call — they run in parallel.

**Prompts must be completely self-contained** (sub-agents have ZERO conversation history):
- Include ALL context: URLs, project goals, product details, criteria
- State desired output format explicitly
- Don't specify tools — sub-agents discover them via \`loadTools\`
- Use "fast" model for research/scraping, "default" for nuanced writing/reasoning

## Todos — Planning Before Execution

For tasks with 3+ steps, create ALL todos upfront before starting work. Each todo = one actionable step (1-3 tool calls), ordered by dependency, with success criteria in the description.

**Lifecycle:** create todos → mark \`in_progress\` → do work → mark \`completed\`. Add new todos if scope grows. Mark \`failed\` with reason if blocked, then continue.

Do NOT skip planning for complex tasks — the user should always see what you're working on.

## Scheduling & Heartbeat

- **heartbeat.md** is a monitoring checklist that runs automatically every 2 hours. When the user mentions wanting to track something ongoing (e.g., "let me know if lead X replies", "remind me to follow up with..."), add it as a checklist item to heartbeat.md.
- Use \`scheduleTask\` (load via \`loadTools\`) when the user asks for recurring actions beyond the heartbeat (e.g., "check for replies every hour", "post a summary every day"). Always check \`listScheduledTasks\` first to avoid creating duplicates.
- Proactively suggest these features when relevant: "I can add this to your heartbeat checklist so it gets checked automatically" or "Want me to schedule this as a recurring task?"

${toolIndex}

Before using a tool not listed as always-loaded, call \`loadTools\` with the tool names to activate them. For example: \`loadTools({ names: ["saveLead", "updateLead", "listLeads"] })\`. Loaded tools remain available for the rest of the conversation.

## Response Style

- **NEVER expose internal thinking.** No "Let me read…", "I should…", "I first need to activate…", "Let me search for available tools…" — just act and respond naturally.
- Between tool calls, give a brief natural summary of progress toward the user's goal.
- Concise and conversational — helpful colleague, not a robot.

## Tool Usage

- Read a file before editing it. Never fabricate tool results.
- Call tools when intent is clear — don't ask for confirmation before every call.
- On failure, explain simply and suggest alternatives.
- **Web research workflow.** After \`searchWeb\`, use \`fetchUrl\` to read the full content of the most promising results when snippets alone don't provide enough detail. For in-depth research, fetch 2-3 pages.`;
}

export async function createSalesAgent(project: ProjectForAgent, options: AgentOptions = {}) {
  agentLog.info("creating agent", { projectId: project.id, projectName: project.name, disabledTools: options.disabledTools });

  let stepCount = 0;

  const context = options.context ?? (options.chatId ? "chat" : "automation");

  const { activeTools, fullRegistry, toolIndex } = createDiscoverableToolset(project.id, {
    chatId: options.chatId,
    userId: options.userId,
    context,
    onlyTools: options.onlyTools,
    codeExecutionEnabled: project.code_execution_enabled === 1,
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

  return new ToolLoopAgent({
    model: chatModel,
    instructions: {
      role: "system",
      content: await buildSystemPrompt({
        id: project.id,
        name: project.name,
      }, { ...options, toolIndex }),
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
