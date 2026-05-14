/**
 * Thin wrapper that drives `runTurn` from a non-WS trigger (scheduler,
 * event triggers, "run task now" button, telegram). Replaces the deleted
 * `runAutonomousTask` from `server/lib/agent/autonomous-agent.ts`.
 *
 * Each call:
 *  - creates a fresh autonomous chat row so the trigger is observable in
 *    the UI,
 *  - runs one Pi turn against that chat's session JSONL,
 *  - returns `{ chatId, summary, suppressed }` for the trigger's run row.
 *
 * "Suppressed" preserves the legacy heartbeat behavior: if the agent
 * replies with literally `HEARTBEAT_OK`, the run is recorded but the
 * chat row is not surfaced.
 */
import { createAutonomousChat } from "@/db/queries/chats.ts";
import { log } from "@/lib/utils/logger.ts";
import { runTurn } from "./run-turn.ts";
import { resolveModelForPi } from "./model.ts";
import { publishPiEvent } from "@/lib/http/ws.ts";

const HEARTBEAT_OK = "HEARTBEAT_OK";
const autoLog = log.child({ module: "pi-autonomous" });

export interface AutonomousTurnResult {
  chatId: string;
  summary: string;
  suppressed: boolean;
}

export async function runAutonomousTurn(
  project: { id: string; name: string },
  taskName: string,
  prompt: string,
  options?: { userId?: string; model?: string },
): Promise<AutonomousTurnResult> {
  const chat = createAutonomousChat(project.id, taskName);
  autoLog.info("running autonomous pi turn", {
    projectId: project.id,
    chatId: chat.id,
    taskName,
  });

  const resolved = resolveModelForPi(options?.model);
  const collected: string[] = [];

  let turn;
  try {
    turn = await runTurn({
      projectId: project.id,
      chatId: chat.id,
      userId: options?.userId ?? "",
      userMessage: prompt,
      model: resolved,
      onEvent: (env) => {
        publishPiEvent(env);
        if (env.event.type === "agent_end") {
          for (const m of env.event.messages) {
            if ((m as any).role !== "assistant") continue;
            const content = (m as any).content;
            if (!Array.isArray(content)) continue;
            for (const c of content) {
              if (c && c.type === "text" && typeof c.text === "string") {
                collected.push(c.text);
              }
            }
          }
        }
      },
    });
  } catch (err) {
    const enriched = err instanceof Error ? err : new Error(String(err));
    (enriched as { chatId?: string }).chatId = chat.id;
    throw enriched;
  }

  // Truncation = model stream cut off mid-response (e.g. Kimi hit its 16384
  // output cap during a thinking loop). Pi exits 0 in this case, but the
  // task did not actually complete. Surface as a failed run so the scheduler
  // doesn't write a misleading "completed" summary.
  if (turn.truncated) {
    const err = new Error(
      `model response truncated: ${turn.truncationReason ?? "no stop_reason"}`,
    );
    (err as { chatId?: string }).chatId = chat.id;
    throw err;
  }

  const responseText = collected.join("\n").trim();
  if (responseText === HEARTBEAT_OK || responseText.startsWith(HEARTBEAT_OK)) {
    return { chatId: chat.id, summary: HEARTBEAT_OK, suppressed: true };
  }

  const summary =
    responseText.length > 200 ? responseText.slice(0, 200) + "..." : responseText;
  return { chatId: chat.id, summary, suppressed: false };
}
