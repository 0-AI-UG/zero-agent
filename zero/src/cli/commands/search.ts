/** `zero search` - vector search over project files and memory. */
import { search } from "../../sdk/search.ts";
import { hasFlag, getOption, printJson } from "../format.ts";

const HELP = `zero search - vector search over project files, memory, and messages

Usage:
  zero search <query> [--collection file|memory|message] [--top-k 10] [--json]

  --collection can be repeated to search multiple collections.
  When omitted, all three collections are searched.
`;

/** Collect all values for a repeatable flag like --collection. */
function getAllOptions(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && i + 1 < args.length) {
      values.push(args[i + 1]!);
    }
  }
  return values;
}

export async function searchCommand(args: string[]): Promise<number> {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(HELP);
    return 0;
  }

  const collections = getAllOptions(args, "--collection");
  const topKStr = getOption(args, "--top-k");
  const topK = topKStr ? parseInt(topKStr, 10) : undefined;

  // Positional args: everything that isn't a flag or a flag value
  const flagsWithValues = new Set(["--collection", "--top-k"]);
  const skipNext = new Set<number>();
  for (let i = 0; i < args.length; i++) {
    if (flagsWithValues.has(args[i]!)) {
      skipNext.add(i);
      skipNext.add(i + 1);
    }
  }
  const positional = args.filter(
    (a, i) => !skipNext.has(i) && !a.startsWith("--"),
  );
  const query = positional.join(" ");

  if (!query) {
    process.stderr.write("zero search: missing query\n");
    return 2;
  }

  const data = await search.query(query, {
    collections:
      collections.length > 0
        ? (collections as ("file" | "memory" | "message")[])
        : undefined,
    topK,
  });

  if (hasFlag(args, "--json")) {
    printJson(data);
  } else {
    for (const r of data.results) {
      const snippet = r.content.replace(/\n/g, " ").slice(0, 200);
      process.stdout.write(
        `[${r.collection}] (${r.score.toFixed(3)}) ${snippet}\n`,
      );
    }
    if (data.results.length === 0) {
      process.stdout.write("No results found.\n");
    }
  }
  return 0;
}
