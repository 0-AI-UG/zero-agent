/** Output helpers shared across CLI commands. */

export function printJson(data: unknown): void {
  process.stdout.write(JSON.stringify({ ok: true, data }) + "\n");
}

export function printError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as any)?.code ?? "error";
  process.stderr.write(`${code}: ${message}\n`);
}

export function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

export function getOption(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1 || i === args.length - 1) return undefined;
  return args[i + 1];
}
