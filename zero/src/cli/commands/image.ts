import { image } from "../../sdk/image.ts";
import { hasFlag, getOption, printJson } from "../format.ts";

const HELP = `zero image — generate images and save them to the project

Usage:
  zero image generate <prompt> [--path <p>] [--json]
`;

export async function imageCommand(args: string[]): Promise<number> {
  const [action, ...rest] = args;
  if (!action || action === "--help" || action === "-h") { process.stdout.write(HELP); return 0; }
  if (action !== "generate") {
    process.stderr.write(`zero image: unknown action "${action}"\n${HELP}`);
    return 2;
  }
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--path") { i++; continue; }
    if (a === "--json") continue;
    positional.push(a);
  }
  const prompt = positional.join(" ");
  if (!prompt) { process.stderr.write("zero image generate: missing prompt\n"); return 2; }
  const data = await image.generate(prompt, { path: getOption(rest, "--path") });
  if (hasFlag(rest, "--json")) printJson(data);
  else process.stdout.write(`generated ${data.filename} (${data.sizeBytes} bytes) -> ${data.path}\n`);
  return 0;
}
