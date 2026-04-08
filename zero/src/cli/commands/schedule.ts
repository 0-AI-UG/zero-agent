import { schedule } from "../../sdk/schedule.ts";
import { hasFlag, getOption, printJson } from "../format.ts";

const HELP = `zero schedule — manage scheduled / event-triggered tasks

Usage:
  zero schedule add --name <n> --prompt <p> [--schedule <expr> | --event <name>] [--cooldown N] [--json]
  zero schedule ls [--json]
  zero schedule update --task <id> [--name <n>] [--prompt <p>] [--schedule <expr>] [--enabled true|false] [--json]
  zero schedule rm --task <id> [--json]
`;

export async function scheduleCommand(args: string[]): Promise<number> {
  const [action, ...rest] = args;
  if (!action || action === "--help" || action === "-h") { process.stdout.write(HELP); return 0; }

  if (action === "add") {
    const name = getOption(rest, "--name");
    const prompt = getOption(rest, "--prompt");
    if (!name || !prompt) { process.stderr.write("zero schedule add: --name and --prompt required\n"); return 2; }
    const sched = getOption(rest, "--schedule");
    const event = getOption(rest, "--event");
    const cooldown = getOption(rest, "--cooldown");
    const data = await schedule.add({
      name, prompt,
      triggerType: event ? "event" : "schedule",
      schedule: sched,
      triggerEvent: event,
      cooldownSeconds: cooldown ? Number(cooldown) : undefined,
    });
    if (hasFlag(rest, "--json")) printJson(data);
    else process.stdout.write(`created ${data.id} (${data.name})\n`);
    return 0;
  }

  if (action === "ls" || action === "list") {
    const data = await schedule.list();
    if (hasFlag(rest, "--json")) printJson(data);
    else for (const t of data.tasks) {
      const trig = t.triggerType === "event" ? `event:${t.triggerEvent}` : t.schedule;
      process.stdout.write(`${t.id}  ${t.enabled ? "[on] " : "[off]"} ${t.name}  (${trig})\n`);
    }
    return 0;
  }

  if (action === "update") {
    const taskId = getOption(rest, "--task");
    if (!taskId) { process.stderr.write("zero schedule update: --task required\n"); return 2; }
    const enabledStr = getOption(rest, "--enabled");
    const data = await schedule.update({
      taskId,
      name: getOption(rest, "--name"),
      prompt: getOption(rest, "--prompt"),
      schedule: getOption(rest, "--schedule"),
      enabled: enabledStr === undefined ? undefined : enabledStr === "true",
    });
    if (hasFlag(rest, "--json")) printJson(data);
    else process.stdout.write(`updated ${data.id}\n`);
    return 0;
  }

  if (action === "rm" || action === "remove") {
    const taskId = getOption(rest, "--task");
    if (!taskId) { process.stderr.write("zero schedule rm: --task required\n"); return 2; }
    const data = await schedule.remove(taskId);
    if (hasFlag(rest, "--json")) printJson(data);
    else process.stdout.write(`removed ${data.deletedTask}\n`);
    return 0;
  }

  process.stderr.write(`zero schedule: unknown action "${action}"\n${HELP}`);
  return 2;
}
