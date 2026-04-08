/**
 * Build script for the `zero` package.
 * Produces dist/cli.js (executable) and dist/sdk.js (library entry).
 *
 * Strategy: in dev/runtime we use tsx, so this build is only needed for
 * the published shape inside the session container image. We use esbuild
 * if available, otherwise fall back to tsc emit.
 */
import { mkdir, writeFile, chmod, copyFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = __dirname;
const dist = resolve(root, "dist");

await mkdir(dist, { recursive: true });

// Use Bun's bundler if available (sessions have Bun), otherwise try esbuild.
async function build() {
  // Prefer Bun.build when running under Bun
  if (typeof (globalThis as any).Bun !== "undefined") {
    const Bun = (globalThis as any).Bun;
    await Bun.build({
      entrypoints: [resolve(root, "src/cli/index.ts")],
      outdir: dist,
      target: "bun",
      format: "esm",
      naming: "cli.js",
    });
    await Bun.build({
      entrypoints: [resolve(root, "src/sdk/index.ts")],
      outdir: dist,
      target: "bun",
      format: "esm",
      naming: "sdk.js",
    });
    return;
  }

  // Fallback: try esbuild
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
    await esbuild.build({
      entryPoints: [resolve(root, "src/sdk/index.ts")],
      outfile: resolve(dist, "sdk.js"),
      bundle: true,
      platform: "node",
      target: "node20",
      format: "esm",
    });
    return;
  } catch {}

  throw new Error("No bundler available (need bun or esbuild)");
}

await build();
await chmod(resolve(dist, "cli.js"), 0o755);
console.log("zero: built dist/cli.js and dist/sdk.js");
