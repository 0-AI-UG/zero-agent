/**
 * Build the system-prompt string passed to the Claude Code CLI via
 * `--append-system-prompt`.
 *
 * Parity goals with the OpenRouter path (see `server/lib/agent/agent.ts`
 * `buildSystemPrompt`):
 *   - Identity block (SOUL.md) + project name + date.
 *   - Language directive.
 *   - Skills: index table AND pre-expanded instructions inline, because
 *     Claude's CLI owns its own tool loop and can't call our `loadSkill`.
 *   - RAG context (relevant memories + file paths) retrieved from the last
 *     user prompt.
 *   - Plan-mode framing.
 *
 * Divergences from OpenRouter:
 *   - Tool index is omitted — Claude has its own built-in tools.
 *   - `zero` CLI hint is kept (still runnable via Claude's Bash tool).
 *   - Skills are pre-expanded (not referenced by name).
 *
 * Length budget: the argument is passed on argv, and the string is also
 * prepended to Claude's own system prompt which is already large. We cap
 * at 100_000 chars (~25K tokens). On overrun, shed in this order:
 *   1. Skill bodies (keep the index).
 *   2. RAG blocks (memories + files).
 *   3. SOUL.md (truncate further).
 */
import { getSkillSummaries, loadFullSkill, checkGating } from "@/lib/skills/loader.ts";
import { buildSkillsIndex } from "@/lib/skills/injector.ts";
import { readFromS3 } from "@/lib/s3.ts";
import { retrieveRagContext, type RagContext } from "@/lib/agent-step/context.ts";
import type { Message } from "@/lib/messages/types.ts";
import { log } from "@/lib/utils/logger.ts";

const promptLog = log.child({ module: "backend:claude-code:prompt" });

const MAX_APPEND_LEN = 100_000;
const MAX_SOUL_LEN = 20_000;
const MAX_SKILL_BODY_LEN = 8_000;

export interface AssembleCliPromptInput {
  project: { id: string; name: string };
  messages: Message[];
  language?: "en" | "zh";
  onlySkills?: string[];
  planMode?: boolean;
}

export async function assembleCliSystemPrompt(input: AssembleCliPromptInput): Promise<string> {
  const { project, messages, language = "en", onlySkills, planMode } = input;

  const lastUserText = extractLastUserText(messages);

  const [soulMd, skillSummariesAll, rag] = await Promise.all([
    readProjectFile(project.id, "SOUL.md"),
    getSkillSummaries(project.id),
    retrieveRagContext(project.id, lastUserText).catch((): RagContext => ({})),
  ]);

  const skillSummaries = onlySkills?.length
    ? skillSummariesAll.filter((s) => onlySkills.includes(s.name))
    : skillSummariesAll;

  const gatedSkills = skillSummaries.filter((s) => checkGating(s.metadata).ok);
  const skillBodies = await Promise.all(
    gatedSkills.map(async (s) => {
      try {
        const full = await loadFullSkill(project.id, s.name);
        if (!full) return null;
        const body = full.instructions.length > MAX_SKILL_BODY_LEN
          ? full.instructions.slice(0, MAX_SKILL_BODY_LEN) + "\n\n[…truncated]"
          : full.instructions;
        return { name: s.name, body, files: full.files };
      } catch (err) {
        promptLog.warn("failed to pre-expand skill", { projectId: project.id, name: s.name, err: String(err) });
        return null;
      }
    }),
  );

  const build = (opts: { includeSkillBodies: boolean; includeRag: boolean; soulLen: number }): string => {
    const today = new Date().toISOString().split("T")[0];
    const sections: string[] = [];

    const identity = soulMd
      ? soulMd.slice(0, opts.soulLen)
      : `You are an AI assistant.`;
    sections.push(`${identity} Project: "${project.name}". Date: ${today}.`);

    if (language === "zh") {
      sections.push(
        "Write all responses and generated content in Chinese unless the user explicitly asks for another language.",
      );
    }

    const skillsIndex = buildSkillsIndex(skillSummaries);
    if (skillsIndex) {
      sections.push(`## Skills\n\n${skillsIndex}`);
    }

    if (opts.includeSkillBodies) {
      for (const s of skillBodies) {
        if (!s) continue;
        const fileList = s.files.length ? `\n\nBundled files: ${s.files.join(", ")}` : "";
        sections.push(`### Skill: ${s.name}\n\n${s.body}${fileList}`);
      }
    }

    sections.push(
      `Use the \`zero\` CLI (via bash) or SDK (installed in global node_modules: \`import { web, browser, llm, ... } from "zero"\` in bun scripts) for web search, fetching pages, browser automation, image generation, scheduling, messaging the user, credentials, port forwarding, and LLM calls. Run \`zero --help\` for usage. Don't install other tools when zero already covers it.`,
    );

    sections.push(
      `Never expose internal thinking. Just act and respond concisely. Never print credentials - use shell substitution.`,
    );

    if (planMode) {
      sections.push(`## Plan Mode

You are in planning mode. Design a thorough plan before any implementation.

1. **Explore**: Read files, understand architecture, gather context.
2. **Ask questions**: If anything is unclear, ask the user before proceeding.
3. **Write a plan**: Save the plan at \`plans/{descriptive-name}.md\` covering:
   - Summary of what will be built
   - Step-by-step implementation approach
   - Files to create or modify
   - Potential risks or trade-offs

Do NOT implement anything. Focus only on exploration and planning.`);
    }

    if (opts.includeRag && rag.relevantMemories?.length) {
      const memLines = rag.relevantMemories.map((m) => `- ${m.content}`).join("\n");
      sections.push(`## Relevant Memories (auto-retrieved)\n\n${memLines}`);
    }
    if (opts.includeRag && rag.relevantFiles?.length) {
      const fileLines = rag.relevantFiles.map((f) => `- ${f.path}`).join("\n");
      sections.push(`## Relevant Files (auto-retrieved)\n\nRead if needed:\n${fileLines}`);
    }

    return sections.join("\n\n");
  };

  let result = build({ includeSkillBodies: true, includeRag: true, soulLen: MAX_SOUL_LEN });
  if (result.length <= MAX_APPEND_LEN) return result;

  promptLog.warn("append-system-prompt over budget; dropping skill bodies", { len: result.length });
  result = build({ includeSkillBodies: false, includeRag: true, soulLen: MAX_SOUL_LEN });
  if (result.length <= MAX_APPEND_LEN) return result;

  promptLog.warn("append-system-prompt still over budget; dropping RAG", { len: result.length });
  result = build({ includeSkillBodies: false, includeRag: false, soulLen: MAX_SOUL_LEN });
  if (result.length <= MAX_APPEND_LEN) return result;

  const soulBudget = Math.max(2_000, MAX_SOUL_LEN - (result.length - MAX_APPEND_LEN));
  promptLog.warn("append-system-prompt over budget; truncating SOUL.md", {
    len: result.length,
    soulBudget,
  });
  return build({ includeSkillBodies: false, includeRag: false, soulLen: soulBudget }).slice(0, MAX_APPEND_LEN);
}

function extractLastUserText(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "user") continue;
    const text = m.parts
      .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
      .map((p) => p.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return undefined;
}

async function readProjectFile(projectId: string, filename: string): Promise<string | undefined> {
  try {
    return await readFromS3(`projects/${projectId}/${filename}`);
  } catch {
    return undefined;
  }
}
