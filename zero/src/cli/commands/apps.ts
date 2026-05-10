/**
 * `zero apps` — manage reverse-proxy slug ↔ port mappings for this project.
 *
 *   zero apps create [name]   allocate a port and return it
 *   zero apps delete <slug>   remove an app
 *   zero apps list            list all apps in this project
 */
import { apps } from "../../sdk/apps.ts";
import { hasFlag, printJson } from "../format.ts";

const HELP = `zero apps - manage forwarded apps

Usage:
  zero apps create [name] [--json]
  zero apps delete <slug>  [--json]
  zero apps list           [--json]

\`create\` allocates a free host port and returns it. Bind your server to that
port; the platform routes /_apps/<slug>/* to 127.0.0.1:<port>. With a name,
\`create\` is idempotent — calling it twice returns the same record.
`;

export async function appsCommand(args: string[]): Promise<number> {
  const [action, ...rest] = args;
  if (!action || action === "--help" || action === "-h") {
    process.stdout.write(HELP);
    return 0;
  }

  const json = hasFlag(rest, "--json");

  if (action === "create") {
    const positional = rest.filter((a) => !a.startsWith("--"));
    const name = positional[0];
    const data = await apps.create(name ? { name } : {});
    if (json) printJson(data);
    else process.stdout.write(`${data.url}\n  port: ${data.port}\n  slug: ${data.slug}\n`);
    return 0;
  }

  if (action === "delete") {
    const positional = rest.filter((a) => !a.startsWith("--"));
    const slug = positional[0];
    if (!slug) {
      process.stderr.write("zero apps delete: missing slug\n");
      return 2;
    }
    const data = await apps.delete({ slug });
    if (json) printJson(data);
    else process.stdout.write(`${data.message}\n`);
    return 0;
  }

  if (action === "list") {
    const data = await apps.list();
    if (json) printJson(data);
    else {
      if (data.apps.length === 0) {
        process.stdout.write("(no apps)\n");
      } else {
        for (const a of data.apps) {
          process.stdout.write(`${a.slug}  port=${a.port}  ${a.url}  ${a.name}\n`);
        }
      }
    }
    return 0;
  }

  process.stderr.write(`zero apps: unknown action "${action}"\n${HELP}`);
  return 2;
}
