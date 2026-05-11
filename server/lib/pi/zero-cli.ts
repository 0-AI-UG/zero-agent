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
  try {
    // lstat-based check via readlinkSync: returns target if symlink, throws otherwise.
    if (readlinkSync(link) !== cliPath) {
      unlinkSync(link);
      symlinkSync(cliPath, link);
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      try {
        symlinkSync(cliPath, link);
      } catch (e) {
        // Lost a race with another concurrent caller — the symlink now exists.
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
    } else if (code === "EINVAL") {
      // Exists but not a symlink (regular file?). Replace it.
      unlinkSync(link);
      symlinkSync(cliPath, link);
    } else {
      throw err;
    }
  }

  cachedBinDir = binDir;
  return binDir;
}
