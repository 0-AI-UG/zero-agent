/** `zero llm generate` - proxy LLM calls through the server. */
import { llm } from "../../sdk/llm.ts";
import { hasFlag, getOption, printJson } from "../format.ts";

const HELP = `zero llm - proxy LLM calls through the server

Usage:
  zero llm generate <prompt> [--system <s>] [--max-tokens <n>] [--json]

  The model is configured by the admin in the project's settings; CLI
  callers cannot pick it.

  Reads from stdin if prompt is "-":
    echo "summarize this" | zero llm generate -
`;

export async function llmCommand(args: string[]): Promise<number> {
  const [action, ...rest] = args;
  if (!action || action === "--help" || action === "-h") {
    process.stdout.write(HELP);
    return 0;
  }

  if (action === "generate") {
    const positional = rest.filter((a, i) => {
      if (a.startsWith("--")) return false;
      const prev = rest[i - 1];
      return prev !== "--system" && prev !== "--max-tokens";
    });
    let prompt = positional.join(" ");
    if (!prompt || prompt === "-") {
      // Read from stdin
      const chunks: string[] = [];
      const reader = process.stdin;
      reader.setEncoding("utf-8");
      for await (const chunk of reader) chunks.push(chunk as string);
      prompt = chunks.join("");
    }
    if (!prompt) { process.stderr.write("zero llm generate: missing prompt\n"); return 2; }

    const system = getOption(rest, "--system");
    const maxTokensStr = getOption(rest, "--max-tokens");
    const maxTokens = maxTokensStr ? parseInt(maxTokensStr, 10) : undefined;

    const data = await llm.generate(prompt, { system, maxTokens });
    if (hasFlag(rest, "--json")) printJson(data);
    else process.stdout.write(data.text + "\n");
    return 0;
  }

  process.stderr.write(`zero llm: unknown action "${action}"\n${HELP}`);
  return 2;
}
