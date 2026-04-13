import type { z } from "zod";
import type { CliContext } from "./context.ts";
import { ok, fail } from "./response.ts";
import {
  insertExperiment,
  getExperimentById,
  getExperimentsByProject,
  updateExperiment,
  insertExperimentResult,
  getRecentExperimentResults,
  getExperimentResults,
} from "@/db/queries/experiments.ts";
import { captureSnapshot, restoreSnapshot } from "@/lib/files/snapshots.ts";
import { insertTask, getTasksByProject, updateTask } from "@/db/queries/scheduled-tasks.ts";
import { parseSchedule } from "@/lib/scheduling/schedule-parser.ts";
import type {
  ExperimentCreateInput,
  ExperimentStartInput,
  ExperimentEvaluateInput,
  ExperimentStatusInput,
  ExperimentStopInput,
  ExperimentListInput,
} from "zero/schemas";

function summarize(e: any) {
  return {
    id: e.id,
    name: e.name,
    metricPattern: e.metric_pattern,
    direction: e.direction,
    instructionsPath: e.instructions_path || undefined,
    targetPath: e.target_path || undefined,
    schedule: e.schedule,
    baselineMetric: e.baseline_metric,
    bestMetric: e.best_metric,
    iterationCount: e.iteration_count,
    status: e.status,
    createdAt: e.created_at,
  };
}

export async function handleExperimentCreate(
  ctx: CliContext,
  input: z.infer<typeof ExperimentCreateInput>,
): Promise<Response> {
  const exp = insertExperiment(ctx.projectId, {
    name: input.name,
    metricPattern: input.metricPattern,
    direction: input.direction,
    instructionsPath: input.instructionsPath,
    targetPath: input.targetPath,
    schedule: input.schedule,
  });

  // Capture baseline snapshot
  const snapshot = await captureSnapshot(ctx.projectId, `experiment:${exp.id}:baseline`);
  updateExperiment(exp.id, { baseline_snapshot_id: snapshot.id, best_snapshot_id: snapshot.id });

  return ok(summarize({ ...exp, baseline_snapshot_id: snapshot.id, best_snapshot_id: snapshot.id }));
}

export async function handleExperimentStart(
  ctx: CliContext,
  input: z.infer<typeof ExperimentStartInput>,
): Promise<Response> {
  const exp = getExperimentById(input.id);
  if (!exp || exp.project_id !== ctx.projectId) return fail("not_found", "Experiment not found", 404);
  if (exp.status !== "created" && exp.status !== "stopped") {
    return fail("invalid", `Cannot start experiment in status '${exp.status}'`);
  }

  // Validate schedule
  const validation = parseSchedule(exp.schedule);
  if (!validation.valid) {
    return fail("invalid", `Invalid schedule '${exp.schedule}': ${validation.error}`);
  }

  // Build the prompt for each autonomous iteration
  const lines: string[] = [
    `Run one iteration of experiment ${exp.id} ("${exp.name}").`,
    ``,
    `1. Check what was tried before:`,
    `   zero experiment status --id ${exp.id} --json`,
    `   Read the recent results and notes to understand trajectory and what to try next.`,
  ];

  if (exp.instructions_path) {
    lines.push(``, `2. Read the instructions file at ${exp.instructions_path}.`);
  }

  if (exp.target_path) {
    lines.push(``, `3. The file to modify is ${exp.target_path}. Make ONE change based on trajectory + instructions.`);
  } else {
    lines.push(``, `3. Decide on ONE modification to try based on trajectory + instructions.`);
  }

  lines.push(
    ``,
    `4. Run the experiment and capture the output.`,
    `   Redirect output to a file - do not flood context.`,
    `   Read only the metric lines (grep or tail).`,
    ``,
    `5. Evaluate:`,
    `   zero experiment evaluate --id ${exp.id} --output "<metric output>" \\`,
    `     --description "short one-line summary" \\`,
    `     --notes "what you changed, why, what the result suggests, what to try next"`,
    ``,
    `The evaluate command handles file rollback automatically via snapshots.`,
    `After evaluating, you are done. Do not loop - each iteration is a separate run.`,
  );

  const iterationPrompt = lines.join("\n");

  // Create the scheduled task
  const task = insertTask(
    ctx.projectId,
    ctx.userId,
    `experiment: ${exp.name}`,
    iterationPrompt,
    exp.schedule,
    true,       // enabled
    undefined,  // requiredTools
    undefined,  // requiredSkills
    "schedule", // triggerType
    undefined,  // triggerEvent
    undefined,  // triggerFilter
    0,          // cooldownSeconds
    500,        // maxSteps
  );

  const updated = updateExperiment(exp.id, { status: "running" });
  return ok({ ...summarize(updated), taskId: task.id });
}

export async function handleExperimentEvaluate(
  ctx: CliContext,
  input: z.infer<typeof ExperimentEvaluateInput>,
): Promise<Response> {
  const exp = getExperimentById(input.id);
  if (!exp || exp.project_id !== ctx.projectId) return fail("not_found", "Experiment not found", 404);
  if (exp.status !== "running") {
    return fail("invalid", `Experiment is not running (status: ${exp.status})`);
  }

  const iteration = exp.iteration_count + 1;
  const description = input.description ?? "";
  const notes = input.notes ?? "";

  // Parse metric from output
  let metric: number | null = null;
  try {
    const regex = new RegExp(exp.metric_pattern);
    const match = regex.exec(input.output);
    if (match && match[1]) {
      metric = parseFloat(match[1]);
      if (isNaN(metric)) metric = null;
    }
  } catch {
    // Invalid regex - record as error
    const result = insertExperimentResult(exp.id, {
      iteration,
      status: "error",
      metric: null,
      bestAtTime: exp.best_metric,
      description: `Failed to parse metric: invalid regex pattern`,
      notes,
    });
    updateExperiment(exp.id, { iteration_count: iteration });
    return ok({
      status: "error" as const,
      metric: null,
      best: exp.best_metric,
      iteration,
      description: result.description,
    });
  }

  if (metric === null) {
    // Could not parse metric - discard and restore
    await restoreSnapshot(ctx.projectId, exp.best_snapshot_id!);
    insertExperimentResult(exp.id, {
      iteration,
      status: "error",
      metric: null,
      bestAtTime: exp.best_metric,
      description: description || "Could not parse metric from output",
      notes,
    });
    updateExperiment(exp.id, { iteration_count: iteration });
    return ok({
      status: "error" as const,
      metric: null,
      best: exp.best_metric,
      iteration,
      description: "Could not parse metric from output",
    });
  }

  // Handle baseline (first evaluation)
  if (exp.best_metric === null) {
    const snapshot = await captureSnapshot(ctx.projectId, `experiment:${exp.id}:iter-${iteration}`);
    insertExperimentResult(exp.id, {
      iteration,
      status: "baseline",
      metric,
      bestAtTime: metric,
      description: description || "baseline",
      notes,
      snapshotId: snapshot.id,
    });
    updateExperiment(exp.id, {
      baseline_metric: metric,
      best_metric: metric,
      best_snapshot_id: snapshot.id,
      iteration_count: iteration,
    });
    return ok({ status: "kept" as const, metric, best: metric, iteration, description });
  }

  // Compare metric
  const improved = exp.direction === "minimize"
    ? metric < exp.best_metric
    : metric > exp.best_metric;

  if (improved) {
    // Keep: capture new snapshot as the new best
    const snapshot = await captureSnapshot(ctx.projectId, `experiment:${exp.id}:iter-${iteration}`);
    insertExperimentResult(exp.id, {
      iteration,
      status: "kept",
      metric,
      bestAtTime: metric,
      description,
      notes,
      snapshotId: snapshot.id,
    });
    updateExperiment(exp.id, {
      best_metric: metric,
      best_snapshot_id: snapshot.id,
      iteration_count: iteration,
    });
    return ok({ status: "kept" as const, metric, best: metric, iteration, description });
  }

  // Discard: restore to last best snapshot
  await restoreSnapshot(ctx.projectId, exp.best_snapshot_id!);
  insertExperimentResult(exp.id, {
    iteration,
    status: "discarded",
    metric,
    bestAtTime: exp.best_metric,
    description,
    notes,
  });
  updateExperiment(exp.id, { iteration_count: iteration });
  return ok({ status: "discarded" as const, metric, best: exp.best_metric, iteration, description });
}

export async function handleExperimentStatus(
  ctx: CliContext,
  input: z.infer<typeof ExperimentStatusInput>,
): Promise<Response> {
  const exp = getExperimentById(input.id);
  if (!exp || exp.project_id !== ctx.projectId) return fail("not_found", "Experiment not found", 404);

  const recent = getRecentExperimentResults(exp.id, 20);
  const all = getExperimentResults(exp.id);
  const kept = all.filter(r => r.status === "kept" || r.status === "baseline").length;
  const successRate = all.length > 0 ? kept / all.length : 0;

  return ok({
    id: exp.id,
    name: exp.name,
    status: exp.status,
    iterationCount: exp.iteration_count,
    baselineMetric: exp.baseline_metric,
    bestMetric: exp.best_metric,
    successRate,
    recentResults: recent.reverse().map(r => ({
      iteration: r.iteration,
      status: r.status,
      metric: r.metric,
      description: r.description,
      notes: r.notes || undefined,
    })),
  });
}

export async function handleExperimentStop(
  ctx: CliContext,
  input: z.infer<typeof ExperimentStopInput>,
): Promise<Response> {
  const exp = getExperimentById(input.id);
  if (!exp || exp.project_id !== ctx.projectId) return fail("not_found", "Experiment not found", 404);

  // Disable the associated scheduled task
  const tasks = getTasksByProject(ctx.projectId);
  const experimentTask = tasks.find(t => t.prompt.includes(`experiment ${exp.id}`));
  if (experimentTask) {
    updateTask(experimentTask.id, { enabled: 0 });
  }

  const updated = updateExperiment(exp.id, { status: "stopped" });
  return ok(summarize(updated));
}

export async function handleExperimentList(
  ctx: CliContext,
  _input: z.infer<typeof ExperimentListInput>,
): Promise<Response> {
  const experiments = getExperimentsByProject(ctx.projectId);
  return ok({ experiments: experiments.map(summarize) });
}
