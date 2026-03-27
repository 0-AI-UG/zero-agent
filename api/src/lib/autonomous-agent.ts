import { generateId } from "ai";
import { createAgent } from "@/lib/agent.ts";
import { getOrCreateAutonomousChat } from "@/db/queries/chats.ts";
import { touchChat } from "@/db/queries/chats.ts";
import { db } from "@/db/index.ts";
import { readFromS3 } from "@/lib/s3.ts";
import { log } from "@/lib/logger.ts";

const autoLog = log.child({ module: "autonomous-agent" });

const HEARTBEAT_OK = "HEARTBEAT_OK";

async function readHeartbeatChecklist(projectId: string): Promise<string | null> {
  try {
    const content = await readFromS3(`projects/${projectId}/heartbeat.md`);
    const trimmed = content.trim();
    // Skip if empty or only headers
    if (!trimmed || /^(#[^\n]*\n?\s*)*$/.test(trimmed)) return null;
    return trimmed;
  } catch {
    return null;
  }
}

interface RunResult {
  chatId: string;
  summary: string;
  suppressed: boolean;
}

const insertOne = db.query<void, [string, string, string, string, string]>(
  "INSERT OR REPLACE INTO messages (id, project_id, chat_id, role, content) VALUES (?, ?, ?, ?, ?)",
);

export async function runAutonomousTask(
  project: { id: string; name: string },
  taskName: string,
  prompt: string,
  options?: { onlyTools?: string[]; onlySkills?: string[]; userId?: string },
): Promise<RunResult> {
  const chat = getOrCreateAutonomousChat(project.id);

  autoLog.info("running autonomous task", {
    projectId: project.id,
    chatId: chat.id,
    taskName,
  });

  // Read heartbeat.md deterministically before calling the LLM
  const checklist = await readHeartbeatChecklist(project.id);

  let fullPrompt = prompt;
  if (checklist) {
    fullPrompt = `${prompt}\n\n## Current heartbeat.md checklist\n\n${checklist}\n\n---\nItems under "## Explore" are self-directed investigations added automatically from past conversations. Pick ONE explore item to investigate using available tools. If the finding is interesting, report it. If not worth reporting, remove the item from heartbeat.md via editFile. Mark completed explore items with [x] or remove them.`;
    autoLog.info("injected heartbeat checklist", {
      projectId: project.id,
      checklistLength: checklist.length,
    });
  } else {
    autoLog.info("no heartbeat checklist found", { projectId: project.id });
  }

  const agent = await createAgent(project, {
    onlyTools: options?.onlyTools,
    onlySkills: options?.onlySkills,
    userId: options?.userId,
  });

  const result = await agent.generate({
    prompt: fullPrompt,
  });

  const responseText = result.text || "No response generated.";

  // If the agent says nothing needs attention, skip persisting to chat
  const isOk = responseText.trim() === HEARTBEAT_OK
    || responseText.trim().startsWith(HEARTBEAT_OK);

  if (isOk) {
    autoLog.info("heartbeat ok, suppressed", {
      projectId: project.id,
      chatId: chat.id,
      taskName,
    });
    return { chatId: chat.id, summary: HEARTBEAT_OK, suppressed: true };
  }

  // Persist to autonomous chat only when there's something to report
  const userMsgId = generateId();
  const assistantMsgId = generateId();

  const userMessage = {
    id: userMsgId,
    role: "user" as const,
    parts: [{ type: "text" as const, text: prompt }],
  };

  const assistantMessage = {
    id: assistantMsgId,
    role: "assistant" as const,
    parts: [{ type: "text" as const, text: responseText }],
  };

  insertOne.run(userMsgId, project.id, chat.id, "user", JSON.stringify(userMessage));
  insertOne.run(assistantMsgId, project.id, chat.id, "assistant", JSON.stringify(assistantMessage));

  touchChat(chat.id);

  const summary = responseText.length > 200
    ? responseText.slice(0, 200) + "..."
    : responseText;

  autoLog.info("autonomous task completed", {
    projectId: project.id,
    chatId: chat.id,
    taskName,
    summaryLength: summary.length,
  });

  return { chatId: chat.id, summary, suppressed: false };
}
