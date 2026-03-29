import { spawn, type Subprocess } from "bun";
import { mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { discoverChrome } from "./chrome-discovery.ts";

const CDP_PORT_START = 18800;
const CDP_PORT_END = 18899;

interface LaunchResult {
  cdpUrl: string;
  process: Subprocess | null;
  reused: boolean;
}

function getUserDataDir(profile: string): string {
  const dir = join(homedir(), ".zero-agent", "browser", profile, "user-data");
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function findRunningCdp(): Promise<string | null> {
  for (let port = CDP_PORT_START; port <= CDP_PORT_END; port++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(500),
      });
      if (res.ok) {
        const data = await res.json() as { webSocketDebuggerUrl?: string };
        if (data.webSocketDebuggerUrl) {
          return data.webSocketDebuggerUrl;
        }
        return `ws://127.0.0.1:${port}/devtools/browser`;
      }
    } catch {
      // port not listening
    }
  }
  return null;
}

async function findFreePort(): Promise<number> {
  for (let port = CDP_PORT_START; port <= CDP_PORT_END; port++) {
    try {
      await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(300),
      });
      // port is in use
    } catch {
      return port;
    }
  }
  throw new Error(`No free CDP port in range ${CDP_PORT_START}-${CDP_PORT_END}`);
}

export interface LaunchOptions {
  profile?: string;
  chromePath?: string;
  port?: number;
  headless?: boolean;
}

export async function launchChrome(options: LaunchOptions = {}): Promise<LaunchResult> {
  const { profile = "default", chromePath: customChromePath, port: customPort, headless = false } = options;

  // Check for already-running Chrome with CDP
  const existingUrl = await findRunningCdp();
  if (existingUrl) {
    console.log(`Found running Chrome with CDP at ${existingUrl}`);
    return { cdpUrl: existingUrl, process: null, reused: true };
  }

  const chromePath = customChromePath ?? discoverChrome();
  if (!chromePath) {
    throw new Error(
      "Chrome not found. Please install Google Chrome or set CHROME_PATH environment variable.",
    );
  }

  const port = customPort ?? await findFreePort();
  const userDataDir = getUserDataDir(profile);

  console.log(`Launching Chrome on CDP port ${port}...`);
  console.log(`  Path: ${chromePath}`);
  console.log(`  User data: ${userDataDir}`);

  const args = [
    chromePath,
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    // Suppress "Chrome is being controlled by automated test software" infobar
    "--disable-infobars",
    // Disable component extensions (like automation extension) that leak detection signals
    "--disable-component-extensions-with-background-pages",
    // Disable the default browser agent which can interfere with automation
    "--disable-default-apps",
  ];
  if (headless) args.push("--headless=new");

  const proc = spawn({
    cmd: args,
    stdout: "ignore",
    stderr: "ignore",
  });

  // Wait for CDP to become available
  let cdpUrl: string | null = null;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(500),
      });
      if (res.ok) {
        const data = await res.json() as { webSocketDebuggerUrl?: string };
        cdpUrl = data.webSocketDebuggerUrl ?? `ws://127.0.0.1:${port}/devtools/browser`;
        break;
      }
    } catch {
      // not ready yet
    }
  }

  if (!cdpUrl) {
    proc.kill();
    throw new Error("Chrome launched but CDP did not become available within 15s");
  }

  console.log(`Chrome ready at ${cdpUrl}`);
  return { cdpUrl, process: proc, reused: false };
}
