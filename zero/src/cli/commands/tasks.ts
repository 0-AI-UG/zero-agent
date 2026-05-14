import { tasks as tasksSdk } from "../../sdk/tasks.ts";
import { hasFlag, getOption, printJson } from "../format.ts";

const HELP = `zero tasks - manage scheduled / event / script tasks

Usage:
  zero tasks add --name <n> --prompt <p>
                 [--schedule <expr> | --event <name> | --script <path>]
                 [--schedule <expr>]   (required for --script)
                 [--cooldown N] [--json]
  zero tasks ls [--json]
  zero tasks update --task <id>
                    [--name <n>] [--prompt <p>] [--schedule <expr>]
                    [--script <path>] [--enabled true|false] [--json]
  zero tasks rm --task <id> [--json]

Trigger types:
  --schedule <expr>   cron-like interval. Examples: "every 15m", "every 2h",
                      "0 9 * * *". Minimum interval is 15m.
  --event <name>      fires on an in-process event (file.created, message.received,
                      task.completed, etc.). Optional --cooldown debounces repeats.
  --script <path>     path (under the project files area) to a .ts file the agent
                      authored. See "Script triggers" below.

Script triggers:
  A script trigger runs a TypeScript file on a cron interval. The script
  decides whether to wake the agent and what context to pass it. Scripts
  live at .zero/triggers/<taskId>.ts by default (or wherever --script
  points), and run under Bun inside the project sandbox.

  Inside the script, import from "zero":

      import { web, trigger } from "zero";

      // Persistent per-task state (JSON; survives across runs).
      const lastSeen = (await trigger.state.get<string>("lastSeen")) ?? "";

      const results = await web.search("anthropic news");
      const top = results.results[0];
      if (!top || top.url === lastSeen) {
        // Nothing new — just exit. The agent is not woken.
        return;
      }

      await trigger.state.set("lastSeen", top.url);

      // Wake the agent. The payload is added to the autonomous turn prompt
      // alongside the task's base prompt. fire() may be called more than
      // once; all calls in a single run are batched into one turn.
      await trigger.fire({ payload: { title: top.title, url: top.url } });

  Notes:
    - The script is responsible for writing itself with the file API; the
      tasks command does NOT create the file for you.
    - Default timeout is 30s (ZERO_SCRIPT_TIMEOUT_MS env override).
    - Exiting without calling trigger.fire() records a "no fire" run and
      does NOT wake the agent. trigger.skip() is a no-op alias for clarity.
    - Non-zero exit + no fire is reported as a failed run with stderr.
`;

export async function tasksCommand(args: string[]): Promise<number> {
  const [action, ...rest] = args;
  if (!action || action === "--help" || action === "-h") { process.stdout.write(HELP); return 0; }

  if (action === "add") {
    const name = getOption(rest, "--name");
    const prompt = getOption(rest, "--prompt");
    if (!name || !prompt) { process.stderr.write("zero tasks add: --name and --prompt required\n"); return 2; }
    const sched = getOption(rest, "--schedule");
    const event = getOption(rest, "--event");
    const script = getOption(rest, "--script");
    const cooldown = getOption(rest, "--cooldown");

    let triggerType: "schedule" | "event" | "script";
    if (script) {
      triggerType = "script";
      if (!sched) {
        process.stderr.write("zero tasks add: --schedule is required when using --script (the cron interval the script runs on)\n");
        return 2;
      }
    } else if (event) {
      triggerType = "event";
    } else {
      triggerType = "schedule";
    }

    const data = await tasksSdk.add({
      name, prompt,
      triggerType,
      schedule: sched,
      triggerEvent: event,
      scriptPath: script,
      cooldownSeconds: cooldown ? Number(cooldown) : undefined,
    });
    if (hasFlag(rest, "--json")) printJson(data);
    else process.stdout.write(`created ${data.id} (${data.name})\n`);
    return 0;
  }

  if (action === "ls" || action === "list") {
    const data = await tasksSdk.list();
    if (hasFlag(rest, "--json")) printJson(data);
    else for (const t of data.tasks) {
      let trig: string;
      if (t.triggerType === "event") trig = `event:${t.triggerEvent}`;
      else if (t.triggerType === "script") trig = `script: ${t.scriptPath ?? `.zero/triggers/${t.id}.ts`}, ${t.schedule}`;
      else trig = t.schedule ?? "";
      process.stdout.write(`${t.id}  ${t.enabled ? "[on] " : "[off]"} ${t.name}  (${trig})\n`);
    }
    return 0;
  }

  if (action === "update") {
    const taskId = getOption(rest, "--task");
    if (!taskId) { process.stderr.write("zero tasks update: --task required\n"); return 2; }
    const enabledStr = getOption(rest, "--enabled");
    const data = await tasksSdk.update({
      taskId,
      name: getOption(rest, "--name"),
      prompt: getOption(rest, "--prompt"),
      schedule: getOption(rest, "--schedule"),
      scriptPath: getOption(rest, "--script"),
      enabled: enabledStr === undefined ? undefined : enabledStr === "true",
    });
    if (hasFlag(rest, "--json")) printJson(data);
    else process.stdout.write(`updated ${data.id}\n`);
    return 0;
  }

  if (action === "rm" || action === "remove") {
    const taskId = getOption(rest, "--task");
    if (!taskId) { process.stderr.write("zero tasks rm: --task required\n"); return 2; }
    const data = await tasksSdk.remove(taskId);
    if (hasFlag(rest, "--json")) printJson(data);
    else process.stdout.write(`removed ${data.deletedTask}\n`);
    return 0;
  }

  process.stderr.write(`zero tasks: unknown action "${action}"\n${HELP}`);
  return 2;
}
