/**
 * One-time Chrome relaunch that side-loads the Zero Companion extension.
 *
 * `--load-extension` only takes effect on a cold Chrome start, so if Chrome is
 * already running we quit it gracefully first (Chrome saves the session) and
 * relaunch with `--restore-last-session` so the user's tabs/logins come back.
 * The extension then connects to the localhost bridge on its own.
 *
 * macOS is the primary, fully-supported path; Windows/Linux are best-effort
 * with a clear manual fallback (Load unpacked in chrome://extensions).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

type Logger = (line: string) => void;

function run(cmd: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.on("error", () => resolve({ code: -1, out }));
    child.on("exit", (code) => resolve({ code: code ?? -1, out }));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function isChromeRunningMac(): Promise<boolean> {
  const { code } = await run("pgrep", ["-x", "Google Chrome"]);
  return code === 0;
}

async function ensureChromeWithExtensionMac(extDir: string, log: Logger): Promise<void> {
  if (await isChromeRunningMac()) {
    log("quitting Chrome so it can reopen with the helper (your session will be restored)…");
    await run("osascript", ["-e", 'tell application "Google Chrome" to quit']);
    // Wait for the process to actually exit before relaunching, else `open`
    // just focuses the live instance and drops our --args.
    for (let i = 0; i < 30; i++) {
      if (!(await isChromeRunningMac())) break;
      await delay(400);
    }
    if (await isChromeRunningMac()) {
      throw new Error("Chrome is still running — quit it (Cmd-Q) and re-run `zero browser connect`.");
    }
  }
  const args = ["-a", "Google Chrome", "--args", `--load-extension=${extDir}`, "--restore-last-session"];
  const { code } = await run("open", args);
  if (code !== 0) throw new Error("could not launch Google Chrome via `open`");
}

function findChromeWindows(): string | null {
  const candidates = [
    join(process.env["PROGRAMFILES"] ?? "C:/Program Files", "Google/Chrome/Application/chrome.exe"),
    join(process.env["PROGRAMFILES(X86)"] ?? "C:/Program Files (x86)", "Google/Chrome/Application/chrome.exe"),
    join(process.env["LOCALAPPDATA"] ?? "", "Google/Chrome/Application/chrome.exe"),
  ];
  return candidates.find((p) => p && existsSync(p)) ?? null;
}

async function ensureChromeWithExtensionWindows(extDir: string, log: Logger): Promise<void> {
  const chrome = findChromeWindows();
  if (!chrome) throw new Error("could not find chrome.exe");
  log("closing Chrome so it can reopen with the helper…");
  await run("taskkill", ["/IM", "chrome.exe", "/F"]);
  await delay(1500);
  const child = spawn(chrome, [`--load-extension=${extDir}`, "--restore-last-session"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

async function ensureChromeWithExtensionLinux(extDir: string, log: Logger): Promise<void> {
  // Best-effort: assume `google-chrome` is on PATH (the common case).
  const bin = "google-chrome";
  log("closing Chrome so it can reopen with the helper…");
  await run("pkill", ["-x", "chrome"]);
  await run("pkill", ["-x", "google-chrome"]);
  await delay(1500);
  const child = spawn(bin, [`--load-extension=${extDir}`, "--restore-last-session"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

/**
 * Relaunch the user's Chrome with the companion extension side-loaded. Quits a
 * running Chrome first (session is restored). Throws if Chrome can't be driven,
 * with the manual Load-unpacked path as the fallback (surfaced by the caller).
 */
export async function ensureChromeWithExtension(extDir: string, log: Logger): Promise<void> {
  switch (process.platform) {
    case "darwin":
      return ensureChromeWithExtensionMac(extDir, log);
    case "win32":
      return ensureChromeWithExtensionWindows(extDir, log);
    default:
      return ensureChromeWithExtensionLinux(extDir, log);
  }
}
