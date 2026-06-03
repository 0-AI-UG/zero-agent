/**
 * Locate — and, if missing, install — Playwright for the laptop companion.
 *
 * Playwright is an OPTIONAL, laptop-only dependency: the in-container `zero`
 * CLI never touches it, so the build keeps it external and it isn't bundled.
 * On a laptop it's loaded lazily the first time `zero browser connect` runs.
 *
 * The shipped CLI is a single bundle at `~/.zero/bin/zero` that runs under Bun.
 * Bun resolves a bare `import("playwright")` by walking up from the bundle:
 *   ~/.zero/bin/node_modules → ~/.zero/node_modules → ~/node_modules → …
 * so Playwright MUST live in `~/.zero/node_modules` to be visible. A global
 * `npm i -g playwright` lands in the npm prefix instead (e.g.
 * /opt/homebrew/lib/node_modules) — off that path — which is why a global
 * install appears to "do nothing". We therefore install into the zero home and
 * resolve from there explicitly, falling back to a one-time auto-install so a
 * freshly-copied bundle heals itself on first use.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { zeroHomeDir } from "../sdk/config.ts";

type Logger = (line: string) => void;

const runningUnderBun = typeof (globalThis as any).Bun !== "undefined";

/** Try the cheap paths: normal resolution, then explicit lookup in ~/.zero. */
async function tryResolve(): Promise<any | null> {
  // 1. Normal resolution. Works in-container and whenever Playwright sits on
  //    the importer's module path (incl. ~/.zero/node_modules for the bundle).
  try {
    return await import("playwright");
  } catch {
    // fall through
  }
  // 2. Explicit lookup rooted at the zero home, independent of where the
  //    bundle was copied to or how it was invoked.
  try {
    const req = createRequire(join(zeroHomeDir(), "package.json"));
    const entry = req.resolve("playwright");
    return await import(pathToFileURL(entry).href);
  } catch {
    return null;
  }
}

function run(cmd: string, args: string[], cwd: string, env?: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: "inherit",
      env: env ? { ...process.env, ...env } : process.env,
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`\`${cmd} ${args.join(" ")}\` exited with code ${code ?? "null"}`)),
    );
  });
}

/**
 * Install the Playwright npm package into the zero home, then best-effort
 * download the bundled Chromium browser (needed only for `--chromium` / the
 * fallback when the user's installed Chrome can't be launched; the default
 * `chrome` channel drives the system Chrome and needs no download).
 */
export async function installPlaywright(log: Logger): Promise<void> {
  const home = zeroHomeDir();

  // Use the running Bun as the package manager when we're under Bun (the
  // shipped artifact always is); otherwise fall back to npm. Skip the default
  // postinstall that would pull all three browser engines — we only want
  // Chromium, fetched explicitly below.
  const skipDownload = { PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" };
  if (runningUnderBun) {
    await run(process.execPath, ["add", "playwright"], home, skipDownload);
  } else {
    await run("npm", ["install", "playwright"], home, skipDownload);
  }

  // Browser binaries are best-effort: a failed/blocked download must not stop
  // the companion from working against the user's installed Google Chrome.
  const cli = join(home, "node_modules", "playwright", "cli.js");
  if (existsSync(cli)) {
    try {
      log("downloading Chromium for the bundled-browser fallback (best-effort)…");
      const runner = runningUnderBun ? process.execPath : "node";
      await run(runner, [cli, "install", "chromium"], home);
    } catch (err) {
      log(
        `note: could not download the bundled Chromium (${err instanceof Error ? err.message : String(err)}). ` +
          `Your installed Google Chrome will still be used; only \`--chromium\` is affected.`,
      );
    }
  }
}

/**
 * Resolve Playwright, auto-installing it into `~/.zero` on first use if it's
 * absent. Throws a precise, actionable error only if installation itself fails.
 */
export async function loadPlaywright(log: Logger): Promise<any> {
  const found = await tryResolve();
  if (found) return found;

  log("Playwright isn't installed yet — installing it now (one-time, ~1–2 min)…");
  try {
    await installPlaywright(log);
  } catch (err) {
    throw new Error(
      `Failed to auto-install Playwright into ${zeroHomeDir()}: ` +
        `${err instanceof Error ? err.message : String(err)}\n` +
        `Install it manually with:  (cd "${zeroHomeDir()}" && ${
          runningUnderBun ? "bun add" : "npm install"
        } playwright)\n` +
        `Note: do NOT use \`npm i -g playwright\` — a global install isn't on the CLI's module path.`,
    );
  }

  const after = await tryResolve();
  if (after) return after;
  throw new Error(
    `Playwright installed into ${zeroHomeDir()} but still couldn't be loaded. ` +
      `Try re-running \`zero browser connect\`, or remove ${join(zeroHomeDir(), "node_modules")} and retry.`,
  );
}
