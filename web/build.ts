#!/usr/bin/env bun
/**
 * Production build for the web frontend using Bun.build.
 * Replaces Vite. Output goes to web/dist/, which the Node server serves
 * (from disk in dev, embedded in compiled prod).
 *
 * Pass --watch to rebuild on file change.
 */
import { rmSync, watch } from "node:fs";
import tailwind from "bun-plugin-tailwind";

const WATCH = process.argv.includes("--watch");

async function build() {
  const start = Date.now();
  const result = await Bun.build({
    entrypoints: ["./src/index.html"],
    outdir: "./dist",
    publicPath: "/",
    minify: !WATCH,
    sourcemap: "linked",
    target: "browser",
    plugins: [tailwind],
    naming: {
      entry: "[name].[ext]",
      chunk: "[name]-[hash].[ext]",
      asset: "[name]-[hash].[ext]",
    },
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    if (!WATCH) process.exit(1);
    return;
  }
  console.log(`Built ${result.outputs.length} files → web/dist/ (${Date.now() - start}ms)`);
}

rmSync("./dist", { recursive: true, force: true });
await build();

if (WATCH) {
  let queued = false;
  let building = false;
  const trigger = async () => {
    if (building) { queued = true; return; }
    building = true;
    try {
      await build();
    } catch (e) {
      console.error(e);
    } finally {
      building = false;
      if (queued) { queued = false; trigger(); }
    }
  };

  for (const dir of ["./src", "./styles"]) {
    watch(dir, { recursive: true }, () => trigger());
  }
  console.log("watching for changes…");
}
