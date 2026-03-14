import { insertTask, getTasksByProject, updateTask } from "@/db/queries/scheduled-tasks.ts";

const DEFAULT_TASKS: {
  name: string;
  prompt: string;
  schedule: string;
  requiredTools: string[];
}[] = [];

export function createDefaultTasks(projectId: string, userId: string): void {
  const existing = getTasksByProject(projectId);
  for (const task of DEFAULT_TASKS) {
    if (existing.some((t) => t.name === task.name)) continue;
    insertTask(projectId, userId, task.name, task.prompt, task.schedule, false, task.requiredTools);
  }
  updateDefaultTasks(projectId);
}

/**
 * Update existing default tasks to match the latest prompt and required_tools.
 * Matches by task name — only updates tasks that still have default names.
 */
function updateDefaultTasks(projectId: string): void {
  const existing = getTasksByProject(projectId);
  for (const defTask of DEFAULT_TASKS) {
    const match = existing.find((t) => t.name === defTask.name);
    if (!match) continue;
    const currentTools = match.required_tools;
    const newTools = JSON.stringify(defTask.requiredTools);
    if (match.prompt !== defTask.prompt || currentTools !== newTools) {
      updateTask(match.id, {
        prompt: defTask.prompt,
        required_tools: newTools,
      });
    }
  }
}
