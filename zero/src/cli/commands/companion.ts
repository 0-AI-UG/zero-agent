import { loadConfig } from "../../sdk/config.ts";
import { CompanionRunner } from "../../companion/runner.ts";
import { BridgeEngine } from "../../companion/bridge-engine.ts";

const SETUP_HELP = `zero browser setup - one-time setup so the agent can use your Chrome

Usage:
  zero browser setup

Adds the "Zero Companion" extension to your Google Chrome. Run this once: it
opens chrome://extensions and the extension folder for you — turn on Developer
mode and drag the folder in. Once it's added it stays added.

After setup, run \`zero browser connect\` to start a session.
`;

const CONNECT_HELP = `zero browser connect - let the agent use YOUR Chrome (with your logins)

Usage:
  zero browser connect
  zero companion        (alias for "zero browser connect")

Lets the agent drive a tab in your own Google Chrome for the bound project —
your real session, your logins, no separate browser. The agent works in its own
tab, so you can keep browsing. While it's driving you'll see "Zero Companion
started debugging this browser" — that's expected. Press Ctrl-C to stop.

Run \`zero browser setup\` once first. Requires \`zero login\`.
`;

function isHelp(args: string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}

/** `zero browser setup` — one-time install of the companion extension. */
export async function companionSetup(args: string[]): Promise<number> {
  if (isHelp(args)) {
    process.stdout.write(SETUP_HELP);
    return 0;
  }
  const write = (line: string) => process.stdout.write(`${line}\n`);
  const engine = new BridgeEngine({ onWarn: write, onStatus: write });
  try {
    await engine.setup();
    return 0;
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  } finally {
    await engine.stop();
  }
}

/** `zero browser connect` — link the agent to your already-installed extension. */
export async function companionConnect(args: string[]): Promise<number> {
  if (isHelp(args)) {
    process.stdout.write(CONNECT_HELP);
    return 0;
  }
  const cfg = loadConfig();
  if (!cfg) {
    process.stderr.write("Not logged in. Run `zero login --url <server> --token <companion-token>` first.\n");
    return 1;
  }

  const write = (line: string) => process.stdout.write(`${line}\n`);
  const runner = new CompanionRunner({
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
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  // Keep the process alive; the runner manages its own reconnect loop.
  await new Promise<void>(() => {});
  return 0;
}

export async function companionCommand(args: string[]): Promise<number> {
  return companionConnect(args);
}
