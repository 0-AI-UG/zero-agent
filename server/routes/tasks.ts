import { authenticateRequest } from "@/lib/auth/auth.ts";
import { corsHeaders } from "@/lib/http/cors.ts";
import { getParams } from "@/lib/http/request.ts";
import { handleError, verifyProjectAccess, toUTC } from "@/routes/utils.ts";
import { NotFoundError, ValidationError } from "@/lib/utils/errors.ts";
import {
  insertTask,
  getTasksByProject,
  getTaskById,
  updateTask,
  deleteTask,
} from "@/db/queries/tasks.ts";
import { insertTaskRun, updateTaskRun, getRunsByTask } from "@/db/queries/task-runs.ts";
import { runAutonomousTurn } from "@/lib/pi/autonomous.ts";
import { getTasksModelId } from "@/lib/providers/index.ts";
import { markTaskRun } from "@/db/queries/tasks.ts";
import { parseSchedule } from "@/lib/tasks/schedule-parser.ts";
import { formatDateForSQLite } from "@/lib/tasks/schedule-parser.ts";
import { registerEventTask, unregisterEventTask, refreshEventTask } from "@/lib/tasks/event-trigger.ts";
import { validateScriptPath } from "@/lib/tasks/script-runner.ts";
import type { TaskRow, TaskRunRow } from "@/db/types.ts";
import type { EventName } from "@/lib/tasks/events.ts";
import { events } from "@/lib/tasks/events.ts";

const VALID_TRIGGER_EVENTS: EventName[] = [
  "file.created", "file.updated", "file.deleted", "file.moved",
  "folder.created", "folder.deleted",
  "chat.created", "chat.deleted",
  "message.received", "message.sent",
  "task.started", "task.completed", "task.failed",
  "skill.loaded", "skill.installed", "skill.uninstalled",
];

function formatTask(row: TaskRow) {
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
    requiredSkills: row.required_skills ? JSON.parse(row.required_skills) as string[] : null,
    triggerType: row.trigger_type,
    triggerEvent: row.trigger_event,
    triggerFilter: row.trigger_filter ? JSON.parse(row.trigger_filter) : null,
    cooldownSeconds: row.cooldown_seconds,
    maxSteps: row.max_steps,
    scriptPath: row.script_path,
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

function verifyTaskOwnership(taskId: string, projectId: string): TaskRow {
  const task = getTaskById(taskId);
  if (!task || task.project_id !== projectId) {
    throw new NotFoundError("Task not found");
  }
  return task;
}

export async function handleListTasks(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId } = getParams<{ projectId: string }>(request);
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

export async function handleCreateTask(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId } = getParams<{ projectId: string }>(request);
    verifyProjectAccess(projectId, userId);

    const body = await request.json() as {
      name?: string;
      prompt?: string;
      schedule?: string;
      requiredSkills?: string[] | null;
      triggerType?: "schedule" | "event" | "script";
      triggerEvent?: string;
      triggerFilter?: Record<string, string>;
      cooldownSeconds?: number;
      maxSteps?: number;
      scriptPath?: string;
    };

    const triggerType = body.triggerType || (body.scriptPath ? "script" : "schedule");

    if (!body.name || !body.prompt) {
      throw new ValidationError("name and prompt are required");
    }

    if (triggerType === "event") {
      if (!body.triggerEvent) {
        throw new ValidationError("triggerEvent is required for event-triggered tasks");
      }
      if (!VALID_TRIGGER_EVENTS.includes(body.triggerEvent as EventName)) {
        throw new ValidationError(`Invalid trigger event. Valid events: ${VALID_TRIGGER_EVENTS.join(", ")}`);
      }
    } else if (triggerType === "script") {
      if (!body.schedule) {
        throw new ValidationError("schedule is required for script-triggered tasks");
      }
      const validation = parseSchedule(body.schedule);
      if (!validation.valid) {
        throw new ValidationError(validation.error!);
      }
      if (body.scriptPath !== undefined) {
        const v = validateScriptPath(body.scriptPath);
        if (!v.valid) throw new ValidationError(v.error!);
      }
    } else {
      if (!body.schedule) {
        throw new ValidationError("schedule is required for schedule-triggered tasks");
      }
      const validation = parseSchedule(body.schedule);
      if (!validation.valid) {
        throw new ValidationError(validation.error!);
      }
    }

    const requiredSkills = Array.isArray(body.requiredSkills) && body.requiredSkills.length > 0
      ? body.requiredSkills
      : undefined;

    const schedule = triggerType === "event" ? "event" : body.schedule!;

    const task = insertTask(
      projectId, userId, body.name, body.prompt, schedule, true,
      requiredSkills,
      triggerType, body.triggerEvent, body.triggerFilter, body.cooldownSeconds ?? 0,
      body.maxSteps,
      triggerType === "script" ? (body.scriptPath ?? null) : null,
    );

    if (triggerType === "event") {
      registerEventTask(task);
    }

    return Response.json(
      { task: formatTask(task) },
      { status: 201, headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleUpdateTask(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId, taskId } = getParams<{ projectId: string; taskId: string }>(request);
    verifyProjectAccess(projectId, userId);
    verifyTaskOwnership(taskId, projectId);

    const body = await request.json() as {
      name?: string;
      prompt?: string;
      schedule?: string;
      enabled?: boolean;
      requiredSkills?: string[] | null;
      triggerType?: "schedule" | "event" | "script";
      triggerEvent?: string;
      triggerFilter?: Record<string, string> | null;
      cooldownSeconds?: number;
      maxSteps?: number | null;
      scriptPath?: string | null;
    };

    if (body.scriptPath !== undefined && body.scriptPath !== null) {
      const v = validateScriptPath(body.scriptPath);
      if (!v.valid) throw new ValidationError(v.error!);
    }

    if (body.schedule !== undefined) {
      const validation = parseSchedule(body.schedule);
      if (!validation.valid) {
        throw new ValidationError(validation.error!);
      }
    }

    if (body.triggerEvent !== undefined && body.triggerEvent !== null) {
      if (!VALID_TRIGGER_EVENTS.includes(body.triggerEvent as EventName)) {
        throw new ValidationError(`Invalid trigger event. Valid events: ${VALID_TRIGGER_EVENTS.join(", ")}`);
      }
    }

    const task = updateTask(taskId, {
      name: body.name,
      prompt: body.prompt,
      schedule: body.schedule,
      enabled: body.enabled !== undefined ? (body.enabled ? 1 : 0) : undefined,
      required_skills: body.requiredSkills !== undefined
        ? (Array.isArray(body.requiredSkills) && body.requiredSkills.length > 0
          ? JSON.stringify(body.requiredSkills)
          : null)
        : undefined,
      trigger_type: body.triggerType,
      trigger_event: body.triggerEvent !== undefined ? (body.triggerEvent ?? null) : undefined,
      trigger_filter: body.triggerFilter !== undefined
        ? (body.triggerFilter ? JSON.stringify(body.triggerFilter) : null)
        : undefined,
      cooldown_seconds: body.cooldownSeconds,
      max_steps: body.maxSteps,
      script_path: body.scriptPath,
    });

    // Re-register event listener if trigger config changed
    if (body.triggerType !== undefined || body.triggerEvent !== undefined || body.enabled !== undefined) {
      refreshEventTask(taskId);
    }

    return Response.json(
      { task: formatTask(task) },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleDeleteTask(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId, taskId } = getParams<{ projectId: string; taskId: string }>(request);
    verifyProjectAccess(projectId, userId);
    verifyTaskOwnership(taskId, projectId);

    unregisterEventTask(taskId);
    deleteTask(taskId);
    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleRunTaskNow(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId, taskId } = getParams<{ projectId: string; taskId: string }>(request);
    const project = verifyProjectAccess(projectId, userId);
    const task = verifyTaskOwnership(taskId, projectId);

    const run = insertTaskRun(task.id, projectId);

    // Run async, don't block the response
    (async () => {
      events.emit("task.started", {
        taskId: task.id, taskName: task.name, projectId: project.id, prompt: task.prompt,
      });
      try {
        const result = await runAutonomousTurn(
          { id: project.id, name: project.name },
          task.name,
          task.prompt,
          { model: getTasksModelId(project.id) },
        );
        updateTaskRun(run.id, {
          status: "completed",
          summary: result.summary,
          chat_id: result.chatId,
          finished_at: formatDateForSQLite(new Date()),
        });
        events.emit("task.completed", {
          taskId: task.id, taskName: task.name, projectId: project.id, response: result.summary ?? "",
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        updateTaskRun(run.id, {
          status: "failed",
          error: errorMsg,
          finished_at: formatDateForSQLite(new Date()),
        });
        events.emit("task.failed", {
          taskId: task.id, taskName: task.name, projectId: project.id, error: errorMsg,
        });
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

export async function handleGetTaskRuns(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId, taskId } = getParams<{ projectId: string; taskId: string }>(request);
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
