import { insertTask, getTasksByProject } from "@/db/queries/scheduled-tasks.ts";

const HEARTBEAT_NAME = "Project Heartbeat";
const HEARTBEAT_SCHEDULE = "every 2h";
const HEARTBEAT_PROMPT = `This is an autonomous heartbeat check. Follow the checklist below strictly. Do not infer or repeat tasks from prior conversations.

For each checklist item, check the relevant data (leads, files, etc.) and report only items that need attention right now.

If nothing needs attention, reply with exactly: HEARTBEAT_OK`;

export function createHeartbeatTask(projectId: string, userId: string): void {
  // Check if a heartbeat already exists for this project
  const existing = getTasksByProject(projectId);
  if (existing.some((t) => t.name === HEARTBEAT_NAME)) return;

  insertTask(projectId, userId, HEARTBEAT_NAME, HEARTBEAT_PROMPT, HEARTBEAT_SCHEDULE);
}
