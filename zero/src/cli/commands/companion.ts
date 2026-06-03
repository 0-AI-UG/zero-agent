import { getOption, hasFlag } from "../format.ts";
import { loadConfig } from "../../sdk/config.ts";
import { CompanionRunner } from "../../companion/runner.ts";

const HELP = `zero browser connect - drive the agent's browser with YOUR local Chrome

Usage:
  zero browser connect [--cdp <url>] [--launch]
  zero companion        (alias for "zero browser connect")

While this is running, the agent's \`zero browser ...\` actions for the bound
project are executed in your local browser instead of the container's headless
one. Stop it with Ctrl-C to hand control back to the container browser.

By default this launches your installed Google Chrome (a fresh window with a
clean automation profile — not your existing logins/tabs). To drive Chrome with
your real profile and sessions, start Chrome with --remote-debugging-port=9222
and attach with --cdp instead.

Options:
  --cdp <url>   Attach to a Chrome already running with remote debugging,
                e.g. start Chrome with --remote-debugging-port=9222 and pass
                --cdp http://127.0.0.1:9222. Uses your existing profile/tabs.
  --chrome      Launch your installed Google Chrome (default).
  --chromium    Launch Playwright's bundled "Chrome for Testing" build instead.

Requires \`zero login\` first. Playwright is installed automatically into
~/.zero on first use if it's missing.
`;

/** Run the companion runner until interrupted. Shared by `browser connect` and `companion`. */
export async function companionConnect(args: string[]): Promise<number> {
  if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
    process.stdout.write(HELP);
    return 0;
  }
  const cfg = loadConfig();
  if (!cfg) {
    process.stderr.write("Not logged in. Run `zero login --url <server> --token <companion-token>` first.\n");
    return 1;
  }

  const cdpUrl = getOption(args, "--cdp");
  const launch = hasFlag(args, "--launch") || !cdpUrl;
  // Default to the user's installed Google Chrome; --chromium opts back into
  // Playwright's bundled "Chrome for Testing" build.
  const channel = hasFlag(args, "--chromium") ? undefined : "chrome";

  const write = (line: string) => process.stdout.write(`${line}\n`);
  const runner = new CompanionRunner({
    cdpUrl,
    launch,
    channel,
    onWarn: write,
    onStatus: write,
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write("\nstopping companion…\n");
    await runner.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  try {
    await runner.start();
  } catch (err) {
    process.stderr.write(`companion failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  // Keep the process alive; the runner manages its own reconnect loop.
  await new Promise<void>(() => {});
  return 0;
}

export async function companionCommand(args: string[]): Promise<number> {
  return companionConnect(args);
}
