import type { Message } from "@/lib/messages/types.ts";
import { generateText } from "@/lib/openrouter/text.ts";
import { getEnrichModelId } from "@/lib/providers/index.ts";
import { readFromS3, writeToS3, deleteFromS3 } from "@/lib/s3.ts";
import { log } from "@/lib/utils/logger.ts";

const csLog = log.child({ module: "compaction-state" });

export interface SubtaskItem {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  notes?: string;
}

/**
 * Structured state preserved across in-band conversation compaction.
 *
 * When the agent's conversation history approaches the context window,
 * `createCompactPrepareStep` evicts old messages and replaces them with a
 * rendered summary of this state. Each compaction re-extracts new information
 * from the evicted messages and merges it in, so the state accumulates over
 * the life of the run.
 */
export interface CompactionState {
  runId: string;
  intent: string;
  completedWork: string[];
  activeDecisions: string[];
  blockers: string[];
  nextSteps: string[];
  plan?: SubtaskItem[];
  updatedAt: string;
}

function s3Key(projectId: string, runId: string): string {
  return `projects/${projectId}/compaction-state/${runId}.json`;
}

export function createEmptyCompactionState(runId: string): CompactionState {
  return {
    runId,
    intent: "",
    completedWork: [],
    activeDecisions: [],
    blockers: [],
    nextSteps: [],
    updatedAt: new Date().toISOString(),
  };
}

const EXTRACTION_PROMPT = `You are extracting structured state from a conversation segment that is about to be evicted from context. Output valid JSON with these fields:

{
  "intent": "One sentence: what is the user/agent trying to accomplish",
  "completedWork": ["Dense one-liner per completed action (max 10 new items)"],
  "activeDecisions": ["Key decisions made with brief rationale (max 5 new items)"],
  "blockers": ["Current open questions or blockers (max 3)"],
  "nextSteps": ["Immediate next actions to take (max 5)"],
  "learnings": ["Facts worth remembering across conversations (max 3)"]
}

Rules:
- Be extremely concise - each item should be one line
- Only include items that would be important for continuing this work
- completedWork: what was actually done, not planned
- activeDecisions: include WHY the decision was made
- blockers: only real blockers, not completed work
- nextSteps: actionable items, not vague goals
- learnings: only facts useful beyond this conversation
- Output ONLY the JSON, no markdown fencing or preamble`;

/**
 * Format messages for the extraction prompt, stripping tool result bloat.
 */
function formatMessagesForExtraction(messages: Message[]): string {
  return messages
    .map((m) => {
      const chunks: string[] = [];
      for (const p of m.parts) {
        if (p.type === "text") chunks.push(p.text);
        else if (p.type === "reasoning") chunks.push(`(thinking) ${p.text}`);
        else if (p.type === "tool-call") chunks.push(`tool-call: ${p.name}`);
        else if (p.type === "tool-output")
          chunks.push(`tool-result: ${(p.errorText ?? "").slice(0, 200) || "ok"}`);
      }
      return `${m.role}: ${chunks.join(" ")}`;
    })
    .join("\n");
}

interface ExtractionResult {
  intent: string;
  completedWork: string[];
  activeDecisions: string[];
  blockers: string[];
  nextSteps: string[];
  learnings: string[];
}

/**
 * Extract structured state from messages being evicted, merge into existing
 * state. Returns the updated state and any learnings for memory extraction.
 */
export async function extractCompactionState(
  messages: Message[],
  existing?: CompactionState,
): Promise<{ state: CompactionState; learnings: string[] }> {
  const state = existing ?? createEmptyCompactionState("");

  const text = formatMessagesForExtraction(messages);
  if (text.length < 50) {
    return { state, learnings: [] };
  }

  let contextPrefix = "";
  if (state.intent) {
    contextPrefix = `Current state before this segment:\n- Intent: ${state.intent}\n- Work done so far: ${state.completedWork.length} items\n- Decisions: ${state.activeDecisions.length} items\n\n`;
  }

  try {
    const result = await generateText({
      model: getEnrichModelId(),
      system: EXTRACTION_PROMPT,
      messages: `${contextPrefix}Conversation segment to extract from:\n\n${text}`,
      maxOutputTokens: 1024,
    });

    const parsed = JSON.parse(result.text) as ExtractionResult;

    // Merge: intent replaces, arrays append (with dedup)
    if (parsed.intent) state.intent = parsed.intent;

    const appendUnique = (target: string[], items: string[]) => {
      for (const item of items) {
        if (!target.some((t) => t.toLowerCase() === item.toLowerCase())) {
          target.push(item);
        }
      }
    };

    appendUnique(state.completedWork, parsed.completedWork ?? []);
    appendUnique(state.activeDecisions, parsed.activeDecisions ?? []);

    // Blockers and nextSteps replace (they reflect current state, not history)
    state.blockers = parsed.blockers ?? [];
    state.nextSteps = parsed.nextSteps ?? [];
    state.updatedAt = new Date().toISOString();

    // Cap array lengths to prevent unbounded growth
    if (state.completedWork.length > 30) {
      state.completedWork = state.completedWork.slice(-30);
    }
    if (state.activeDecisions.length > 15) {
      state.activeDecisions = state.activeDecisions.slice(-15);
    }

    csLog.info("extracted compaction state", {
      intent: state.intent.slice(0, 80),
      completedWork: state.completedWork.length,
      decisions: state.activeDecisions.length,
      learnings: (parsed.learnings ?? []).length,
    });

    return { state, learnings: parsed.learnings ?? [] };
  } catch (err) {
    csLog.warn("extraction failed, keeping existing state", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { state, learnings: [] };
  }
}

/**
 * Render compaction state as a structured message for injection into context.
 */
export function renderCompactionState(state: CompactionState): string {
  const sections: string[] = [];

  sections.push("## Prior Conversation State (preserved across compaction)\n");

  if (state.intent) {
    sections.push(`**Intent:** ${state.intent}`);
  }

  if (state.completedWork.length > 0) {
    sections.push("**Completed work:**");
    for (const item of state.completedWork) {
      sections.push(`- ${item}`);
    }
  }

  if (state.activeDecisions.length > 0) {
    sections.push("\n**Key decisions:**");
    for (const item of state.activeDecisions) {
      sections.push(`- ${item}`);
    }
  }

  if (state.blockers.length > 0) {
    sections.push("\n**Open blockers:**");
    for (const item of state.blockers) {
      sections.push(`- ${item}`);
    }
  }

  if (state.nextSteps.length > 0) {
    sections.push("\n**Next steps:**");
    for (const item of state.nextSteps) {
      sections.push(`- ${item}`);
    }
  }

  if (state.plan && state.plan.length > 0) {
    sections.push("\n**Task plan:**");
    for (const item of state.plan) {
      const mark = item.status === "completed" ? "x"
        : item.status === "failed" ? "!"
        : item.status === "in_progress" ? "~"
        : " ";
      const suffix = item.notes ? ` - ${item.notes}` : "";
      sections.push(`- [${mark}] ${item.title}${suffix}`);
    }
  }

  return sections.join("\n");
}

export async function saveCompactionState(
  projectId: string,
  runId: string,
  state: CompactionState,
): Promise<void> {
  state.runId = runId;
  state.updatedAt = new Date().toISOString();
  await writeToS3(s3Key(projectId, runId), JSON.stringify(state));
  csLog.debug("saved compaction state", { projectId, runId });
}

export async function loadCompactionState(
  projectId: string,
  runId: string,
): Promise<CompactionState | null> {
  try {
    const raw = await readFromS3(s3Key(projectId, runId));
    return JSON.parse(raw) as CompactionState;
  } catch {
    return null;
  }
}

export async function deleteCompactionState(
  projectId: string,
  runId: string,
): Promise<void> {
  try {
    await deleteFromS3(s3Key(projectId, runId));
    csLog.debug("deleted compaction state", { projectId, runId });
  } catch {
    // Ignore - state may not exist
  }
}
