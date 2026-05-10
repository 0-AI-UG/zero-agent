/**
 * Make the `zero` CLI resolvable on PATH for spawned Pi turns without
 * requiring a manual `npm link` or Dockerfile symlink.
 *
 * Resolves the workspace `zero` package, locates its `dist/cli.js`, and
 * idempotently materializes a `zero` symlink in a stable bin dir. The
 * caller (runTurn) prepends this dir to the child's PATH.
 */
import { chmodSync, existsSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let cachedBinDir: string | null = null;

function resolveZeroDist(): { cli: string; sdk: string } {
  // `zero` is a workspace package with `"main": "./dist/sdk.js"` — resolvable
  // by name. Walk to the package root and pick the dist artifacts.
  const sdk = require.resolve("zero");
  const root = path.dirname(path.dirname(sdk));
  const cli = path.join(root, "dist", "cli.js");
  if (!existsSync(cli)) {
    throw new Error(
      `zero CLI not found at ${cli} — run \`bun --filter zero build\` first`,
    );
  }
  return { cli, sdk };
}

export function resolveZeroSdkPath(): string {
  return resolveZeroDist().sdk;
}

/**
 * Ensure a `zero` executable exists on PATH and return the directory to
 * prepend. Safe to call repeatedly.
 */
export function ensureZeroOnPath(): string {
  if (cachedBinDir) return cachedBinDir;

  const { cli: cliPath } = resolveZeroDist();
  chmodSync(cliPath, 0o755);

  // Co-locate the bin dir with the resolved CLI so it follows the install.
  const binDir = path.join(path.dirname(path.dirname(cliPath)), ".bin");
  mkdirSync(binDir, { recursive: true });

  const link = path.join(binDir, "zero");
  let needsLink = true;
  if (existsSync(link)) {
    try {
      if (readlinkSync(link) === cliPath) needsLink = false;
      else unlinkSync(link);
    } catch {
      // Not a symlink (regular file?). Replace it.
      unlinkSync(link);
    }
  }
  if (needsLink) symlinkSync(cliPath, link);

  cachedBinDir = binDir;
  return binDir;
}
