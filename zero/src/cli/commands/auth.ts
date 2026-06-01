import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { getOption, hasFlag, printJson } from "../format.ts";
import {
  loadConfig,
  saveConfig,
  clearConfig,
  configFilePath,
  type CompanionConfig,
} from "../../sdk/config.ts";
import { apiRequest } from "../../sdk/remote-client.ts";
import { ZeroError } from "../../sdk/errors.ts";

const HELP = `zero login / logout / whoami - connect this machine to a zero server

Usage:
  zero login --url <server> [--json]
  zero logout [--json]
  zero whoami [--json]

\`zero login\` opens a browser to your zero server, where you enter a short code
and pick a project to connect this computer to. A project-scoped credential is
then saved to ${configFilePath()} (0600) and used to drive that project's
control plane (tasks, etc.) and connect your local browser.
`;

interface CompanionMe {
  userId: string;
  username: string;
  projectId: string;
  projectName: string | null;
}

interface DeviceStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  interval: number;
  expiresInSeconds: number;
}

interface DevicePoll {
  status: "pending" | "approved" | "denied" | "expired";
  token?: string;
  projectId?: string;
  projectName?: string | null;
  baseUrl?: string;
}

/** Best-effort: open `url` in the user's default browser. Never throws. */
function openBrowser(url: string): void {
  try {
    const cmd =
      process.platform === "darwin" ? "open"
      : process.platform === "win32" ? "cmd"
      : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Headless or no opener available — the printed URL is the fallback.
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function deviceLogin(url: string, json: boolean): Promise<number> {
  const base = url.replace(/\/+$/, "");

  // 1. Start: these two endpoints are unauthenticated, so we hit them directly
  //    rather than through apiRequest (which always attaches a bearer).
  const startRes = await fetch(`${base}/api/companion/device/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceName: hostname() }),
  });
  if (!startRes.ok) {
    process.stderr.write(`zero login: server rejected the request (HTTP ${startRes.status})\n`);
    return 1;
  }
  const start = (await startRes.json()) as DeviceStart;

  // 2. Prompt + open the browser.
  if (!json) {
    process.stdout.write(
      `\nTo connect this computer, open:\n  ${start.verificationUri}\n\n` +
        `and enter the code:  ${start.userCode}\n\n` +
        `Opening your browser…\n`,
    );
  }
  openBrowser(start.verificationUriComplete);

  // 3. Poll until resolved or expired.
  const deadline = Date.now() + start.expiresInSeconds * 1000;
  const intervalMs = Math.max(1, start.interval) * 1000;
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const pollRes = await fetch(`${base}/api/companion/device/poll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceCode: start.deviceCode }),
    });
    // Transient errors (e.g. 429) — just keep waiting.
    if (!pollRes.ok) continue;
    const poll = (await pollRes.json()) as DevicePoll;

    if (poll.status === "pending") continue;
    if (poll.status === "denied") {
      process.stderr.write("zero login: request was denied in the browser\n");
      return 1;
    }
    if (poll.status === "expired") {
      process.stderr.write("zero login: the code expired before it was approved\n");
      return 1;
    }
    if (poll.status === "approved" && poll.token && poll.projectId) {
      const cfg: CompanionConfig = {
        baseUrl: poll.baseUrl?.replace(/\/+$/, "") ?? base,
        token: poll.token,
        projectId: poll.projectId,
        projectName: poll.projectName ?? undefined,
      };
      saveConfig(cfg);
      if (json) {
        printJson({ loggedIn: true, projectId: cfg.projectId, projectName: cfg.projectName ?? null });
      } else {
        process.stdout.write(
          `\n✓ Connected to ${cfg.projectName ?? "your project"}\n`,
        );
      }
      return 0;
    }
  }

  process.stderr.write("zero login: timed out waiting for approval\n");
  return 1;
}

export async function authCommand(action: string, args: string[]): Promise<number> {
  if (action === "--help" || action === "-h" || hasFlag(args, "--help") || hasFlag(args, "-h")) {
    process.stdout.write(HELP);
    return 0;
  }

  if (action === "login") {
    const url = getOption(args, "--url");
    if (!url) {
      process.stderr.write("zero login: --url is required\n");
      return 2;
    }
    try {
      return await deviceLogin(url, hasFlag(args, "--json"));
    } catch (err) {
      const msg = err instanceof ZeroError ? err.message : String(err);
      process.stderr.write(`zero login: ${msg}\n`);
      return 1;
    }
  }

  if (action === "logout") {
    clearConfig();
    if (hasFlag(args, "--json")) printJson({ loggedOut: true });
    else process.stdout.write("logged out\n");
    return 0;
  }

  if (action === "whoami") {
    const cfg = loadConfig();
    if (!cfg) {
      process.stderr.write("not logged in (run `zero login --url <server>`)\n");
      return 1;
    }
    const me = await apiRequest<CompanionMe>("GET", "/api/companion/me");
    if (hasFlag(args, "--json")) {
      printJson({ baseUrl: cfg.baseUrl, ...me });
    } else {
      process.stdout.write(
        `${me.username} @ ${cfg.baseUrl} → ${me.projectName ?? "your project"}\n`,
      );
    }
    return 0;
  }

  process.stderr.write(`zero: unknown auth action "${action}"\n${HELP}`);
  return 2;
}
