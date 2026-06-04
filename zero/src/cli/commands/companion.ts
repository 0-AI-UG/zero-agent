import { getOption, hasFlag } from "../format.ts";
import { loadConfig } from "../../sdk/config.ts";
import { CompanionRunner } from "../../companion/runner.ts";

const HELP = `zero browser connect - let the agent use YOUR Chrome (with your logins)

Usage:
  zero browser connect
  zero companion        (alias for "zero browser connect")

Opens your Google Chrome with your existing logins and cookies, and the agent
drives that window for the bound project. Press Ctrl-C to stop and hand control
back to the agent's own browser.

Quit Google Chrome before running this: Chrome only lets one program use a
profile at a time, so your normal Chrome must be fully closed first.

Requires \`zero login\` first. The browser tools install automatically on first
use, which can take a minute.

Advanced options (most people don't need these):
  --cdp <url>          Attach to a Chrome started with --remote-debugging-port
                       instead of launching one (lets your Chrome stay open).
  --chromium           Use the bundled browser instead of your installed Chrome.
  --user-data-dir <p>  Profile root to use (default: your OS's Chrome location).
  --profile <name>     Profile to load, e.g. "Default" or "Profile 1"
                       (default: the profile Chrome last used).
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
  const userDataDir = getOption(args, "--user-data-dir");
  const profileDirectory = getOption(args, "--profile");

  const write = (line: string) => process.stdout.write(`${line}\n`);
  const runner = new CompanionRunner({
    cdpUrl,
    launch,
    channel,
    userDataDir,
    profileDirectory,
    onWarn: write,
    onStatus: write,
    // Displaced by another computer on this account: the runner has already
    // stopped and printed why, so exit cleanly rather than hang idle.
    onTakenOver: () => process.exit(0),
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
