import { hasFlag } from "../format.ts";
import { loadConfig } from "../../sdk/config.ts";
import { CompanionRunner } from "../../companion/runner.ts";

const HELP = `zero browser connect - let the agent use YOUR Chrome (with your logins)

Usage:
  zero browser connect
  zero companion        (alias for "zero browser connect")

Installs the Zero Companion extension into your Google Chrome and lets the agent
drive your active tab for the bound project — your real session, your logins, no
separate browser. You can keep browsing while it works. Press Ctrl-C to stop and
hand control back to the agent's own browser.

The first time (or after you fully quit Chrome), Chrome reopens once with the
helper loaded — your tabs are restored. Chrome shows "Zero Companion started
debugging this browser" while the agent is driving; that's expected.

Requires \`zero login\` first.

Options:
  --no-launch   Don't reopen Chrome automatically. Load the extension yourself
                via chrome://extensions (Developer mode → Load unpacked), then
                this just waits for it to connect.
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

  const noLaunch = hasFlag(args, "--no-launch");

  const write = (line: string) => process.stdout.write(`${line}\n`);
  const runner = new CompanionRunner({
    noLaunch,
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
