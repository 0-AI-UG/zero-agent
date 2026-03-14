import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import type { Logger } from "./logger.ts";

export function isFirstRun(profile: string): boolean {
  const dir = join(homedir(), ".leadsagent", "browser", profile, "user-data");
  return !existsSync(dir);
}

export async function getChromeVersion(chromePath: string): Promise<string | null> {
  try {
    const proc = spawn({
      cmd: [chromePath, "--version"],
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    const version = text.trim();
    return version || null;
  } catch {
    return null;
  }
}

export async function printStartupInfo(opts: {
  logger: Logger;
  chromePath: string | null;
  profile: string;
  port: number | undefined;
  serverUrl: string;
  headless: boolean;
  firstRun: boolean;
}) {
  const { logger, chromePath, profile, port, serverUrl, headless, firstRun } = opts;

  const pkg = await import("../package.json");

  logger.banner([
    `LeadsAgent Companion v${pkg.version}`,
    "─".repeat(30),
  ]);

  if (chromePath) {
    logger.info(`Chrome:   ${chromePath}`);
    const version = await getChromeVersion(chromePath);
    if (version) logger.info(`Version:  ${version}`);
  }

  if (port) logger.info(`CDP port: ${port}`);
  logger.info(`Server:   ${serverUrl}`);
  logger.info(`Profile:  ${profile}`);
  if (headless) logger.info(`Mode:     headless`);
  console.log();

  if (firstRun) {
    logger.info("First run detected — creating browser profile...");
  }
}
