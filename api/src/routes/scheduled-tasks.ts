import type { BunRequest } from "bun";
import { authenticateRequest } from "@/lib/auth.ts";
import { corsHeaders } from "@/lib/cors.ts";
import { handleError, verifyProjectAccess, toUTC } from "@/routes/utils.ts";
import { NotFoundError, ValidationError } from "@/lib/errors.ts";
import {
  insertTask,
  getTasksByProject,
  getTaskById,
  updateTask,
  deleteTask,
} from "@/db/queries/scheduled-tasks.ts";
import { insertTaskRun, updateTaskRun, getRunsByTask } from "@/db/queries/task-runs.ts";
import { runAutonomousTask } from "@/lib/autonomous-agent.ts";
import { markTaskRun } from "@/db/queries/scheduled-tasks.ts";
import { parseSchedule } from "@/lib/schedule-parser.ts";
import { formatDateForSQLite } from "@/lib/schedule-parser.ts";
import { insertNotification } from "@/db/queries/notifications.ts";
import { getProjectMembers } from "@/db/queries/members.ts";
import type { ScheduledTaskRow, TaskRunRow } from "@/db/types.ts";

function formatTask(row: ScheduledTaskRow) {
  return {
    id: row.id,
    projectId: row.project_id,
    userId: row.user_id,
    name: row.name,
    prompt: row.prompt,
    schedule: row.schedule,
    enabled: row.enabled === 1,
    lastRunAt: row.last_run_at ? toUTC(row.last_run_at) : null,
    nextRunAt: toUTC(row.next_run_at),
    runCount: row.run_count,
    requiredTools: row.required_tools ? JSON.parse(row.required_tools) as string[] : null,
    requiredSkills: row.required_skills ? JSON.parse(row.required_skills) as string[] : null,
    createdAt: toUTC(row.created_at),
    updatedAt: toUTC(row.updated_at),
  };
}

function formatRun(row: TaskRunRow) {
  return {
    id: row.id,
    taskId: row.task_id,
    projectId: row.project_id,
    chatId: row.chat_id,
    status: row.status,
    summary: row.summary,
    startedAt: toUTC(row.started_at),
    finishedAt: row.finished_at ? toUTC(row.finished_at) : null,
    error: row.error,
  };
}

function verifyTaskOwnership(taskId: string, projectId: string): ScheduledTaskRow {
  const task = getTaskById(taskId);
  if (!task || task.project_id !== projectId) {
    throw new NotFoundError("Task not found");
  }
  return task;
}

export async function handleListTasks(request: BunRequest): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId } = request.params as { projectId: string };
    verifyProjectAccess(projectId, userId);

    const rows = getTasksByProject(projectId);
    return Response.json(
      { tasks: rows.map(formatTask) },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleCreateTask(request: BunRequest): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId } = request.params as { projectId: string };
    verifyProjectAccess(projectId, userId);

    const body = await request.json() as { name?: string; prompt?: string; schedule?: string; requiredTools?: string[] | null; requiredSkills?: string[] | null };

    if (!body.name || !body.prompt || !body.schedule) {
      throw new ValidationError("name, prompt, and schedule are required");
    }

    const validation = parseSchedule(body.schedule);
    if (!validation.valid) {
      throw new ValidationError(validation.error!);
    }

    const requiredTools = Array.isArray(body.requiredTools) && body.requiredTools.length > 0
      ? body.requiredTools
      : undefined;

    const requiredSkills = Array.isArray(body.requiredSkills) && body.requiredSkills.length > 0
      ? body.requiredSkills
      : undefined;

    const task = insertTask(projectId, userId, body.name, body.prompt, body.schedule, true, requiredTools, requiredSkills);
    return Response.json(
      { task: formatTask(task) },
      { status: 201, headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleUpdateTask(request: BunRequest): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId, taskId } = request.params as { projectId: string; taskId: string };
    verifyProjectAccess(projectId, userId);
    verifyTaskOwnership(taskId, projectId);

    const body = await request.json() as {
      name?: string;
      prompt?: string;
      schedule?: string;
      enabled?: boolean;
      requiredTools?: string[] | null;
      requiredSkills?: string[] | null;
    };

    if (body.schedule !== undefined) {
      const validation = parseSchedule(body.schedule);
      if (!validation.valid) {
        throw new ValidationError(validation.error!);
      }
    }

    const task = updateTask(taskId, {
      name: body.name,
      prompt: body.prompt,
      schedule: body.schedule,
      enabled: body.enabled !== undefined ? (body.enabled ? 1 : 0) : undefined,
      required_tools: body.requiredTools !== undefined
        ? (Array.isArray(body.requiredTools) && body.requiredTools.length > 0
          ? JSON.stringify(body.requiredTools)
          : null)
        : undefined,
      required_skills: body.requiredSkills !== undefined
        ? (Array.isArray(body.requiredSkills) && body.requiredSkills.length > 0
          ? JSON.stringify(body.requiredSkills)
          : null)
        : undefined,
    });

    return Response.json(
      { task: formatTask(task) },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleDeleteTask(request: BunRequest): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId, taskId } = request.params as { projectId: string; taskId: string };
    verifyProjectAccess(projectId, userId);
    verifyTaskOwnership(taskId, projectId);

    deleteTask(taskId);
    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleRunTaskNow(request: BunRequest): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId, taskId } = request.params as { projectId: string; taskId: string };
    const project = verifyProjectAccess(projectId, userId);
    const task = verifyTaskOwnership(taskId, projectId);

    const run = insertTaskRun(task.id, projectId);

    // Run async, don't block the response
    (async () => {
      try {
        const onlyTools = task.required_tools ? JSON.parse(task.required_tools) : undefined;
        const result = await runAutonomousTask(
          { id: project.id, name: project.name },
          task.name,
          task.prompt,
          { onlyTools },
        );
        updateTaskRun(run.id, {
          status: "completed",
          summary: result.summary,
          chat_id: result.chatId,
          finished_at: formatDateForSQLite(new Date()),
        });
        const members = getProjectMembers(projectId);
        for (const member of members) {
          insertNotification(member.user_id, "task_completed", {
            projectId,
            projectName: project.name,
            taskName: task.name,
            runId: run.id,
            chatId: result.chatId,
            summary: result.summary,
          });
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        updateTaskRun(run.id, {
          status: "failed",
          error: errorMsg,
          finished_at: formatDateForSQLite(new Date()),
        });
        const members = getProjectMembers(projectId);
        for (const member of members) {
          insertNotification(member.user_id, "task_failed", {
            projectId,
            projectName: project.name,
            taskName: task.name,
            runId: run.id,
            error: errorMsg,
          });
        }
      }
    })();

    return Response.json(
      { run: formatRun(run) },
      { status: 202, headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleGetTaskRuns(request: BunRequest): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId, taskId } = request.params as { projectId: string; taskId: string };
    verifyProjectAccess(projectId, userId);
    verifyTaskOwnership(taskId, projectId);

    const rows = getRunsByTask(taskId);
    return Response.json(
      { runs: rows.map(formatRun) },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}
