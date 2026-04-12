/** `zero web {search,fetch}` - thin shell over sdk/web.ts. */
import { web } from "../../sdk/web.ts";
import { hasFlag, printJson } from "../format.ts";

const HELP = `zero web - search and fetch web pages

Usage:
  zero web search <query> [--json]
  zero web fetch <url> [--query <q>] [--json]
`;

export async function webCommand(args: string[]): Promise<number> {
  const [action, ...rest] = args;
  if (!action || action === "--help" || action === "-h") {
    process.stdout.write(HELP);
    return 0;
  }

  if (action === "search") {
    const query = rest.filter(a => !a.startsWith("--")).join(" ");
    if (!query) { process.stderr.write("zero web search: missing query\n"); return 2; }
    const data = await web.search(query);
    if (hasFlag(rest, "--json")) printJson(data);
    else {
      for (const r of data.results) {
        process.stdout.write(`${r.title}\n  ${r.url}\n  ${r.description ?? ""}\n\n`);
      }
    }
    return 0;
  }

  if (action === "fetch") {
    const positional = rest.filter(a => !a.startsWith("--"));
    const url = positional[0];
    if (!url) { process.stderr.write("zero web fetch: missing url\n"); return 2; }
    const qIdx = rest.indexOf("--query");
    const query = qIdx >= 0 ? rest[qIdx + 1] : undefined;
    const data = await web.fetch(url, query);
    if (hasFlag(rest, "--json")) printJson(data);
    else {
      if (data.title) process.stdout.write(`# ${data.title}\n${data.url}\n\n`);
      if (data.relevantExcerpts) process.stdout.write(data.relevantExcerpts.join("\n---\n") + "\n");
      else if (data.content) process.stdout.write(data.content + "\n");
    }
    return 0;
  }

  process.stderr.write(`zero web: unknown action "${action}"\n${HELP}`);
  return 2;
}
