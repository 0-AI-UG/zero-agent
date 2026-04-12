/** `zero embed` — generate vector embeddings through the server. */
import { readFileSync } from "node:fs";
import { embed } from "../../sdk/embed.ts";
import { hasFlag, getOption, printJson } from "../format.ts";

const HELP = `zero embed — generate vector embeddings

Usage:
  zero embed <text>                  Embed a single text
  echo "text" | zero embed -        Embed from stdin
  zero embed --batch file.txt       Embed multiple texts (one per line)
  [--json]                          Full JSON response
`;

export async function embedCommand(args: string[]): Promise<number> {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(HELP);
    return 0;
  }

  const batchFile = getOption(args, "--batch");
  let texts: string[];

  if (batchFile) {
    const content = readFileSync(batchFile, "utf-8");
    texts = content.split("\n").filter(Boolean);
  } else {
    const positional = args.filter((a, i) => {
      if (a.startsWith("--")) return false;
      const prev = args[i - 1];
      return prev !== "--batch";
    });
    let text = positional.join(" ");
    if (!text || text === "-") {
      const chunks: string[] = [];
      const reader = process.stdin;
      reader.setEncoding("utf-8");
      for await (const chunk of reader) chunks.push(chunk as string);
      text = chunks.join("");
    }
    if (!text) {
      process.stderr.write("zero embed: missing text\n");
      return 2;
    }
    texts = [text];
  }

  const data = await embed.texts(texts);
  if (hasFlag(args, "--json")) {
    printJson(data);
  } else {
    process.stdout.write(
      `${data.embeddings.length} embedding(s), ${data.dimensions} dimensions, model: ${data.model}\n`,
    );
  }
  return 0;
}
