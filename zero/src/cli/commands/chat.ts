import { chat } from "../../sdk/chat.ts";
import { hasFlag, getOption, printJson } from "../format.ts";

const HELP = `zero chat — semantic search over past conversations

Usage:
  zero chat search <query> [--limit N] [--json]
`;

export async function chatCommand(args: string[]): Promise<number> {
  const [action, ...rest] = args;
  if (!action || action === "--help" || action === "-h") {
    process.stdout.write(HELP);
    return 0;
  }
  if (action !== "search") {
    process.stderr.write(`zero chat: unknown action "${action}"\n${HELP}`);
    return 2;
  }
  const positional = rest.filter((a, i) => !a.startsWith("--") && rest[i - 1] !== "--limit");
  const query = positional.join(" ");
  if (!query) { process.stderr.write("zero chat search: missing query\n"); return 2; }
  const limit = Number(getOption(rest, "--limit") ?? 5);
  const data = await chat.search(query, limit);
  if (hasFlag(rest, "--json")) printJson(data);
  else for (const r of data) process.stdout.write(`[${r.role}] ${r.snippet}\n  chat=${r.chatId} score=${r.score.toFixed(3)}\n\n`);
  return 0;
}
