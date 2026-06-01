import { hasFlag, printJson } from "../format.ts";
import { remote } from "../../sdk/remote.ts";
import { hasConfig } from "../../sdk/config.ts";

const HELP = `zero projects - inspect the project this companion is bound to

Usage:
  zero projects ls [--json]      list the bound project (companion tokens are
                                 scoped to a single project)
  zero projects current [--json] show the bound project id/name

Only available in laptop mode (after \`zero login\`).
`;

export async function projectsCommand(args: string[]): Promise<number> {
  const [action, ...rest] = args;
  if (!action || action === "--help" || action === "-h") { process.stdout.write(HELP); return 0; }

  if (!hasConfig()) {
    process.stderr.write("zero projects is only available after `zero login`.\n");
    return 2;
  }

  if (action === "ls" || action === "list") {
    const projects = await remote.listProjects();
    if (hasFlag(rest, "--json")) printJson({ projects });
    else for (const p of projects) {
      process.stdout.write(`${p.id}  ${p.name}${p.isArchived ? " [archived]" : ""}\n`);
    }
    return 0;
  }

  if (action === "current") {
    const bound = remote.boundProject();
    if (!bound) { process.stderr.write("not logged in\n"); return 1; }
    if (hasFlag(rest, "--json")) printJson(bound);
    else process.stdout.write(`${bound.id}${bound.name ? `  ${bound.name}` : ""}\n`);
    return 0;
  }

  process.stderr.write(`zero projects: unknown action "${action}"\n${HELP}`);
  return 2;
}
