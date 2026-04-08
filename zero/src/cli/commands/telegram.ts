import { telegram } from "../../sdk/telegram.ts";
import { hasFlag, getOption, printJson } from "../format.ts";

const HELP = `zero telegram — send messages to the project's Telegram chat

Usage:
  zero telegram send <text> [--chat <id>] [--parse Markdown|HTML] [--json]
`;

export async function telegramCommand(args: string[]): Promise<number> {
  const [action, ...rest] = args;
  if (!action || action === "--help" || action === "-h") { process.stdout.write(HELP); return 0; }
  if (action !== "send") {
    process.stderr.write(`zero telegram: unknown action "${action}"\n${HELP}`);
    return 2;
  }
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--chat" || a === "--parse") { i++; continue; }
    if (a === "--json") continue;
    positional.push(a);
  }
  const text = positional.join(" ");
  if (!text) { process.stderr.write("zero telegram send: missing text\n"); return 2; }
  const chatId = getOption(rest, "--chat");
  const parseMode = getOption(rest, "--parse") as "Markdown" | "HTML" | undefined;
  const data = await telegram.send(text, { chatId, parseMode });
  if (hasFlag(rest, "--json")) printJson(data);
  else process.stdout.write(`sent ${data.textLength} chars to chat ${data.chatId}\n`);
  return 0;
}
