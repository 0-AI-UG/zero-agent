import { experiment } from "../../sdk/experiment.ts";
import { hasFlag, getOption, printJson } from "../format.ts";

const HELP = `zero experiment - autonomous hill-climbing experiment loop

Each iteration runs as a separate autonomous agent invocation with zero context
accumulation. The agent's reasoning persists via --notes on evaluate, and the
next run reads it back via status.

Setup (interactive, agent + human):
  1. Create an experiment:
     zero experiment create --name "optimize-training" \\
       --metric "val_loss: ([0-9.]+)" --direction minimize \\
       --instructions program.md --target train.py \\
       --schedule "every 10m"

  2. Start it (automatically creates a scheduled task):
     zero experiment start --id <id>

Single iteration (what the scheduled agent does each run):
  1. zero experiment status --id <id> --json
     Read recent results + notes to understand trajectory and past reasoning
  2. Read the instructions file (program.md) for guidance on what to explore
  3. Read the target file, decide on a modification based on trajectory
  4. Edit the target file via bash
  5. Run: timeout <budget>s <run-command> 2>&1
  6. zero experiment evaluate --id <id> --output "..." \\
       --description "short summary" \\
       --notes "detailed reasoning: what I changed, why I thought it would \\
       work, what I observed, and what I'd suggest trying next"
     The evaluate command handles keep/discard via S3 snapshots automatically.

Commands:
  create     Set up a new experiment (interactive, with user)
  start      Mark experiment as running
  evaluate   Parse metric, keep or discard (mechanical - uses snapshots)
  status     Show progress, recent results, and notes from past iterations
  stop       End the experiment and show summary
  list       List experiments in this project

The --notes field is critical: it carries reasoning between stateless iterations.
Write what you changed, why, what the result suggests, and what to try next.
The next agent run reads these notes via status to maintain continuity.
`;


export async function experimentCommand(args: string[]): Promise<number> {
  const [action, ...rest] = args;
  if (!action || action === "--help" || action === "-h") {
    process.stdout.write(HELP);
    return 0;
  }

  if (action === "create") {
    const name = getOption(rest, "--name");
    const metric = getOption(rest, "--metric");
    if (!name || !metric) {
      process.stderr.write("zero experiment create: --name and --metric required\n");
      return 2;
    }
    const direction = getOption(rest, "--direction");
    const data = await experiment.create({
      name,
      metricPattern: metric,
      direction: direction === "maximize" ? "maximize" : direction === "minimize" ? "minimize" : undefined,
      instructionsPath: getOption(rest, "--instructions"),
      targetPath: getOption(rest, "--target"),
      schedule: getOption(rest, "--schedule"),
    });
    if (hasFlag(rest, "--json")) printJson(data);
    else process.stdout.write(`created experiment ${data.id} (${data.name})\nmetric: ${data.metricPattern} (${data.direction})\nschedule: ${data.schedule}\n`);
    return 0;
  }

  if (action === "start") {
    const id = getOption(rest, "--id");
    if (!id) { process.stderr.write("zero experiment start: --id required\n"); return 2; }
    const data = await experiment.start(id);
    if (hasFlag(rest, "--json")) printJson(data);
    else {
      process.stdout.write(`started experiment ${data.id} (${data.name})\n`);
      if ((data as any).taskId) process.stdout.write(`scheduled task: ${(data as any).taskId}\n`);
    }
    return 0;
  }

  if (action === "evaluate") {
    const id = getOption(rest, "--id");
    const output = getOption(rest, "--output");
    if (!id || output === undefined) {
      process.stderr.write("zero experiment evaluate: --id and --output required\n");
      return 2;
    }
    const data = await experiment.evaluate({
      id,
      output: output ?? "",
      description: getOption(rest, "--description"),
      notes: getOption(rest, "--notes"),
    });
    if (hasFlag(rest, "--json")) printJson(data);
    else {
      const icon = data.status === "kept" ? "+" : "-";
      const metricStr = data.metric != null ? data.metric.toFixed(6) : "N/A";
      const bestStr = data.best != null ? data.best.toFixed(6) : "N/A";
      process.stdout.write(`[${icon}] iteration ${data.iteration}: ${data.status} (metric=${metricStr}, best=${bestStr})\n`);
      if (data.description) process.stdout.write(`    ${data.description}\n`);
    }
    return 0;
  }

  if (action === "status") {
    const id = getOption(rest, "--id");
    if (!id) { process.stderr.write("zero experiment status: --id required\n"); return 2; }
    const data = await experiment.status(id);
    if (hasFlag(rest, "--json")) printJson(data);
    else {
      process.stdout.write(`experiment: ${data.name} [${data.status}]\n`);
      process.stdout.write(`iterations: ${data.iterationCount}, success rate: ${(data.successRate * 100).toFixed(1)}%\n`);
      const baseStr = data.baselineMetric != null ? data.baselineMetric.toFixed(6) : "N/A";
      const bestStr = data.bestMetric != null ? data.bestMetric.toFixed(6) : "N/A";
      process.stdout.write(`baseline: ${baseStr}, best: ${bestStr}\n`);
      if (data.recentResults.length > 0) {
        process.stdout.write(`\nrecent:\n`);
        for (const r of data.recentResults) {
          const icon = r.status === "kept" ? "+" : "-";
          const m = r.metric != null ? r.metric.toFixed(6) : "N/A";
          process.stdout.write(`  [${icon}] #${r.iteration}: ${m} ${r.description}\n`);
          if (r.notes) process.stdout.write(`      notes: ${r.notes}\n`);
        }
      }
    }
    return 0;
  }

  if (action === "stop") {
    const id = getOption(rest, "--id");
    if (!id) { process.stderr.write("zero experiment stop: --id required\n"); return 2; }
    const data = await experiment.stop(id);
    if (hasFlag(rest, "--json")) printJson(data);
    else process.stdout.write(`stopped experiment ${data.id} (${data.name})\nbest metric: ${data.bestMetric ?? "N/A"}, iterations: ${data.iterationCount}\n`);
    return 0;
  }

  if (action === "ls" || action === "list") {
    const data = await experiment.list();
    if (hasFlag(rest, "--json")) printJson(data);
    else {
      if (data.experiments.length === 0) {
        process.stdout.write("no experiments\n");
      } else {
        for (const e of data.experiments) {
          const bestStr = e.bestMetric != null ? e.bestMetric.toFixed(6) : "N/A";
          process.stdout.write(`${e.id}  [${e.status}] ${e.name}  (best: ${bestStr}, iter: ${e.iterationCount})\n`);
        }
      }
    }
    return 0;
  }

  process.stderr.write(`zero experiment: unknown action "${action}"\n${HELP}`);
  return 2;
}
