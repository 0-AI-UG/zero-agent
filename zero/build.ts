/**
 * Build script for the `zero` package.
 * Produces dist/cli.js (executable).
 *
 * The SDK itself is shipped as TypeScript source under src/sdk/ — both
 * Bun (used to run agent scripts) and tsx (server runtime) execute .ts
 * directly, and shipping source lets the agent read the individual
 * module files (web.ts, browser.ts, …) to reverse-engineer the API
 * instead of staring at one bundled blob.
 */
import { mkdir, chmod, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = __dirname;
const dist = resolve(root, "dist");

await mkdir(dist, { recursive: true });

// Remove the legacy bundled SDK if a prior build left it behind, so the
// only resolvable entry is src/sdk/index.ts via package.json.
await rm(resolve(dist, "sdk.js"), { force: true });

async function build() {
  if (typeof (globalThis as any).Bun !== "undefined") {
    const Bun = (globalThis as any).Bun;
    await Bun.build({
      entrypoints: [resolve(root, "src/cli/index.ts")],
      outdir: dist,
      target: "bun",
      format: "esm",
      naming: "cli.js",
    });
    return;
  }

  try {
    const esbuild = await import("esbuild");
    await esbuild.build({
      entryPoints: [resolve(root, "src/cli/index.ts")],
      outfile: resolve(dist, "cli.js"),
      bundle: true,
      platform: "node",
      target: "node20",
      format: "esm",
      banner: { js: "#!/usr/bin/env node" },
    });
    return;
  } catch {}

  throw new Error("No bundler available (need bun or esbuild)");
}

await build();
await chmod(resolve(dist, "cli.js"), 0o755);
console.log("zero: built dist/cli.js (SDK ships as source under src/sdk/)");
