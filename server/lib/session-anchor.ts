import type { ModelMessage } from "@ai-sdk/provider-utils";
import { generateText } from "ai";
import { getEnrichModel } from "@/lib/providers/index.ts";
import { readFromS3, writeToS3, deleteFromS3 } from "@/lib/s3.ts";
import { log } from "@/lib/logger.ts";

const anchorLog = log.child({ module: "session-anchor" });

export interface SubtaskItem {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  notes?: string;
}

export interface SessionAnchor {
  runId: string;
  intent: string;
  completedWork: string[];
  activeDecisions: string[];
  blockers: string[];
  nextSteps: string[];
  plan?: SubtaskItem[];
  continuationNumber: number;
  totalStepsExecuted: number;
  updatedAt: string;
}

function s3Key(projectId: string, runId: string): string {
  return `projects/${projectId}/session-anchors/${runId}.json`;
}

export function createEmptyAnchor(runId: string): SessionAnchor {
  return {
    runId,
    intent: "",
    completedWork: [],
    activeDecisions: [],
    blockers: [],
    nextSteps: [],
    continuationNumber: 0,
    totalStepsExecuted: 0,
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
- Be extremely concise — each item should be one line
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
function formatMessagesForExtraction(messages: ModelMessage[]): string {
  return messages
    .map((m) => {
      if (m.role === "tool") {
        const parts = m.content as Array<{ toolName?: string; toolCallId?: string }>;
        if (Array.isArray(parts)) {
          return parts
            .map((p) => `tool-result: ${p.toolName ?? "unknown"}`)
            .join("\n");
        }
        return `tool: ${JSON.stringify(m.content).slice(0, 200)}`;
      }
      const content = typeof m.content === "string"
        ? m.content
        : JSON.stringify(m.content);
      return `${m.role}: ${content}`;
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
 * Extract structured state from messages being evicted, merge into existing anchor.
 * Returns the updated anchor and any learnings for memory extraction.
 */
export async function extractAnchor(
  messages: ModelMessage[],
  existingAnchor?: SessionAnchor,
): Promise<{ anchor: SessionAnchor; learnings: string[] }> {
  const anchor = existingAnchor ?? createEmptyAnchor("");

  const text = formatMessagesForExtraction(messages);
  if (text.length < 50) {
    return { anchor, learnings: [] };
  }

  let contextPrefix = "";
  if (anchor.intent) {
    contextPrefix = `Current state before this segment:\n- Intent: ${anchor.intent}\n- Work done so far: ${anchor.completedWork.length} items\n- Decisions: ${anchor.activeDecisions.length} items\n\n`;
  }

  try {
    const result = await generateText({
      model: getEnrichModel(),
      system: EXTRACTION_PROMPT,
      prompt: `${contextPrefix}Conversation segment to extract from:\n\n${text}`,
      maxOutputTokens: 1024,
    });

    const parsed = JSON.parse(result.text) as ExtractionResult;

    // Merge: intent replaces, arrays append (with dedup)
    if (parsed.intent) anchor.intent = parsed.intent;

    const appendUnique = (target: string[], items: string[]) => {
      for (const item of items) {
        if (!target.some((t) => t.toLowerCase() === item.toLowerCase())) {
          target.push(item);
        }
      }
    };

    appendUnique(anchor.completedWork, parsed.completedWork ?? []);
    appendUnique(anchor.activeDecisions, parsed.activeDecisions ?? []);

    // Blockers and nextSteps replace (they reflect current state, not history)
    anchor.blockers = parsed.blockers ?? [];
    anchor.nextSteps = parsed.nextSteps ?? [];
    anchor.updatedAt = new Date().toISOString();

    // Cap array lengths to prevent unbounded growth
    if (anchor.completedWork.length > 30) {
      anchor.completedWork = anchor.completedWork.slice(-30);
    }
    if (anchor.activeDecisions.length > 15) {
      anchor.activeDecisions = anchor.activeDecisions.slice(-15);
    }

    anchorLog.info("extracted anchor", {
      intent: anchor.intent.slice(0, 80),
      completedWork: anchor.completedWork.length,
      decisions: anchor.activeDecisions.length,
      learnings: (parsed.learnings ?? []).length,
    });

    return { anchor, learnings: parsed.learnings ?? [] };
  } catch (err) {
    anchorLog.warn("anchor extraction failed, keeping existing", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { anchor, learnings: [] };
  }
}

/**
 * Render an anchor as a structured message for injection into context.
 */
export function renderAnchor(anchor: SessionAnchor): string {
  const sections: string[] = [];

  sections.push("## Session Context (preserved across compaction)\n");

  if (anchor.intent) {
    sections.push(`**Intent:** ${anchor.intent}`);
  }

  if (anchor.completedWork.length > 0) {
    sections.push("**Completed work:**");
    for (const item of anchor.completedWork) {
      sections.push(`- ${item}`);
    }
  }

  if (anchor.activeDecisions.length > 0) {
    sections.push("\n**Key decisions:**");
    for (const item of anchor.activeDecisions) {
      sections.push(`- ${item}`);
    }
  }

  if (anchor.blockers.length > 0) {
    sections.push("\n**Open blockers:**");
    for (const item of anchor.blockers) {
      sections.push(`- ${item}`);
    }
  }

  if (anchor.nextSteps.length > 0) {
    sections.push("\n**Next steps:**");
    for (const item of anchor.nextSteps) {
      sections.push(`- ${item}`);
    }
  }

  if (anchor.plan && anchor.plan.length > 0) {
    sections.push("\n**Task plan:**");
    for (const item of anchor.plan) {
      const mark = item.status === "completed" ? "x"
        : item.status === "failed" ? "!"
        : item.status === "in_progress" ? "~"
        : " ";
      const suffix = item.notes ? ` — ${item.notes}` : "";
      sections.push(`- [${mark}] ${item.title}${suffix}`);
    }
  }

  if (anchor.continuationNumber > 0) {
    sections.push(`\n_Continuation ${anchor.continuationNumber}, ${anchor.totalStepsExecuted} total steps executed._`);
  }

  return sections.join("\n");
}

export async function saveAnchor(
  projectId: string,
  runId: string,
  anchor: SessionAnchor,
): Promise<void> {
  anchor.runId = runId;
  anchor.updatedAt = new Date().toISOString();
  await writeToS3(s3Key(projectId, runId), JSON.stringify(anchor));
  anchorLog.debug("saved anchor", { projectId, runId });
}

export async function loadAnchor(
  projectId: string,
  runId: string,
): Promise<SessionAnchor | null> {
  try {
    const raw = await readFromS3(s3Key(projectId, runId));
    return JSON.parse(raw) as SessionAnchor;
  } catch {
    return null;
  }
}

export async function deleteAnchor(
  projectId: string,
  runId: string,
): Promise<void> {
  try {
    await deleteFromS3(s3Key(projectId, runId));
    anchorLog.debug("deleted anchor", { projectId, runId });
  } catch {
    // Ignore — anchor may not exist
  }
}
