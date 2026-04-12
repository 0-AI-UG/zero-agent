/**
 * `zero browser ...` - drive the per-project Chromium session.
 *
 * The whole reason this command exists: a 15-action browser flow used to
 * cost 15 agent steps. Now the agent can do the entire flow in a single
 * `bash` heredoc with several `zero browser ...` calls and only one
 * tool result reaches the model.
 *
 * SECURITY: `zero browser fill` accepts the value as a positional argv
 * and the response body intentionally does NOT echo the value back, so
 * `zero browser fill "#pw" "$(zero creds get foo)"` keeps the secret
 * out of the model's tool result.
 */
import { browser } from "../../sdk/browser.ts";
import * as fs from "node:fs/promises";
import { hasFlag, getOption, printJson } from "../format.ts";

const HELP = `zero browser - drive the per-project browser session

Usage:
  zero browser open <url>
  zero browser click <ref>
  zero browser fill <ref> <text> [--submit]
  zero browser screenshot [-o file.png] [--json]
  zero browser evaluate <script>
  zero browser wait <ms>
  zero browser snapshot [--mode interactive|full] [--selector <css>]
  zero browser extract <query> [--max <n>]
  zero browser status

Context-efficient tip: prefer \`snapshot\` (text a11y tree) or \`extract\` (query-driven paragraphs) over \`screenshot\` / full DOM dumps.

All commands support --json. Element refs come from a snapshot.
`;

export async function browserCommand(args: string[]): Promise<number> {
  const [action, ...rest] = args;
  if (!action || action === "--help" || action === "-h") { process.stdout.write(HELP); return 0; }

  const positional = rest.filter(a => !a.startsWith("--") && a !== "-o");
  // Strip --option <value> pairs from positional
  const opts: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith("--") || a === "-o") { opts.push(a); if (rest[i + 1] && !rest[i + 1]!.startsWith("--")) { opts.push(rest[i + 1]!); i++; } }
  }
  const json = hasFlag(rest, "--json");

  const print = (data: any) => {
    if (json) printJson(data);
    else process.stdout.write((typeof data === "string" ? data : JSON.stringify(data, null, 2)) + "\n");
  };

  switch (action) {
    case "open": {
      if (!positional[0]) { process.stderr.write("zero browser open: missing url\n"); return 2; }
      print(await browser.open(positional[0]));
      return 0;
    }
    case "click": {
      if (!positional[0]) { process.stderr.write("zero browser click: missing ref\n"); return 2; }
      print(await browser.click(positional[0]));
      return 0;
    }
    case "fill": {
      const ref = positional[0];
      const text = positional[1];
      if (!ref || text === undefined) { process.stderr.write("zero browser fill: missing ref or text\n"); return 2; }
      const result = await browser.fill(ref, text, { submit: hasFlag(rest, "--submit") });
      // Strip any echoed text the runner might include defensively.
      if (result && typeof result === "object" && "text" in result) delete (result as any).text;
      print(result);
      return 0;
    }
    case "screenshot": {
      // Screenshots are captured + downscaled on the runner (~1024px JPEG@60),
      // then the server writes them directly to project storage and returns
      // only a compact `{path, fileId, ...}` reference - no base64 on the wire.
      // Read the image back with `zero` / the in-process readFile tool using
      // the returned path when you actually need to look at it.
      const result = await browser.screenshot();
      const outFile = getOption(rest, "-o") ?? getOption(rest, "--out");
      if (outFile && result?.path) {
        // Caller asked for a local copy too - pull it via fs by project path.
        // The server-returned `path` is project-relative and the container's
        // workspace root is the project root, so a plain copy works.
        try {
          const src = await fs.readFile(result.path);
          await fs.writeFile(outFile, src);
          if (!json) process.stdout.write(`saved ${outFile}\n`);
          else printJson({ ...result, file: outFile });
          return 0;
        } catch (err) {
          process.stderr.write(
            `zero browser screenshot: failed to copy to ${outFile}: ${err instanceof Error ? err.message : String(err)}\n`,
          );
          // Fall through and still print the server reference below.
        }
      }
      print(result);
      return 0;
    }
    case "evaluate": {
      const script = positional.join(" ");
      if (!script) { process.stderr.write("zero browser evaluate: missing script\n"); return 2; }
      print(await browser.evaluate(script));
      return 0;
    }
    case "wait": {
      const ms = Number(positional[0] ?? 0);
      if (!ms) { process.stderr.write("zero browser wait: missing ms\n"); return 2; }
      print(await browser.wait(ms));
      return 0;
    }
    case "snapshot": {
      const mode = getOption(rest, "--mode") as "interactive" | "full" | undefined;
      const selector = getOption(rest, "--selector");
      print(await browser.snapshot({ mode, selector }));
      return 0;
    }
    case "extract": {
      const query = positional.join(" ");
      if (!query) { process.stderr.write("zero browser extract: missing query\n"); return 2; }
      const maxStr = getOption(rest, "--max");
      const maxExcerpts = maxStr ? Number(maxStr) : undefined;
      print(await browser.extract(query, { maxExcerpts }));
      return 0;
    }
    case "status": {
      print(await browser.status());
      return 0;
    }
    default:
      process.stderr.write(`zero browser: unknown action "${action}"\n${HELP}`);
      return 2;
  }
}
