import { generateText } from "ai";
import { getEnrichModel } from "@/lib/openrouter.ts";
import type { SubtaskItem } from "@/lib/session-anchor.ts";
import { deferAsync } from "@/lib/deferred.ts";
import { log } from "@/lib/logger.ts";

const decompLog = log.child({ module: "task-decomposition" });

const DECOMPOSITION_PROMPT = `You decompose a high-level task into concrete subtasks that can each be completed independently in a single agent session (~50 tool-calling steps).

Output a JSON array of subtasks:
[
  { "id": "1", "title": "Short description of what to do" },
  { "id": "2", "title": "..." }
]

Rules:
- 3-8 subtasks, ordered by dependency (earlier subtasks first)
- Each subtask should be self-contained and completable in one session
- Titles should be actionable imperatives ("Fetch and analyze X", "Update Y config")
- Do NOT include meta-tasks like "plan" or "review" — those happen automatically
- Output ONLY the JSON array, no markdown fencing or preamble`;

/**
 * Decompose a large task prompt into subtasks.
 * Returns null if the task is too simple to decompose.
 */
export async function decomposeTask(
  prompt: string,
  projectContext?: string,
): Promise<SubtaskItem[] | null> {
  const input = projectContext
    ? `Project context:\n${projectContext}\n\nTask:\n${prompt}`
    : prompt;

  try {
    const result = await deferAsync(() => generateText({
      model: getEnrichModel(),
      system: DECOMPOSITION_PROMPT,
      prompt: input,
      maxOutputTokens: 1024,
    }));

    const parsed = JSON.parse(result.text) as Array<{ id: string; title: string }>;

    if (!Array.isArray(parsed) || parsed.length < 2) {
      decompLog.debug("task too simple to decompose", { subtasks: parsed?.length ?? 0 });
      return null;
    }

    const subtasks: SubtaskItem[] = parsed.map((item) => ({
      id: item.id,
      title: item.title,
      status: "pending" as const,
    }));

    decompLog.info("decomposed task", {
      subtaskCount: subtasks.length,
      titles: subtasks.map((s) => s.title.slice(0, 50)),
    });

    return subtasks;
  } catch (err) {
    decompLog.warn("task decomposition failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Minimum prompt length to trigger automatic decomposition */
export const DECOMPOSE_THRESHOLD = 500;

/**
 * Check if a task should be decomposed based on heuristics.
 */
export function shouldDecompose(prompt: string, explicit?: boolean): boolean {
  if (explicit === true) return true;
  return prompt.length > DECOMPOSE_THRESHOLD;
}
