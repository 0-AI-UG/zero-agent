#!/usr/bin/env bun
/**
 * Builds the full application:
 * 1. Builds the web frontend into web/dist/
 * 2. Embeds the built assets into a TS module
 * 3. Compiles server + frontend into dist/zero-agent
 * 4. Compiles companion into dist/zero-agent-companion
 * 5. Builds desktop Electrobun app (combined server + web + companion)
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, extname } from "node:path";
import { $ } from "bun";

const DIST_DIR = join(import.meta.dir, "web/dist");
const GENERATED = join(import.meta.dir, "server/_generated");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

// Step 1: Build frontend
console.log("1/4 Building frontend...");
await $`bun run --cwd web build.ts`.quiet();
const distFiles = readdirSync(DIST_DIR).filter((f) => !f.endsWith(".map"));
console.log(`    ${distFiles.length} files`);

// Step 2: Generate embedded assets module
console.log("2/4 Embedding assets...");
mkdirSync(GENERATED, { recursive: true });

const entries: string[] = [];
for (const file of distFiles) {
  const content = readFileSync(join(DIST_DIR, file));
  const ext = extname(file);
  const mime = MIME_TYPES[ext] ?? "application/octet-stream";
  const isHashed = /[-\.][a-z0-9]{8,}\.\w+$/.test(file);
  entries.push(
    `  "/${file}": { data: Buffer.from("${content.toString("base64")}", "base64"), mime: "${mime}", immutable: ${isHashed} }`,
  );
}

writeFileSync(
  join(GENERATED, "assets.ts"),
  `// Auto-generated — do not edit\nexport const assets: Record<string, { data: Buffer; mime: string; immutable: boolean }> = {\n${entries.join(",\n")}\n};\n`,
);

// Step 3: Compile server, companion, and desktop in parallel
const OUT_DIR = join(import.meta.dir, "dist");
mkdirSync(OUT_DIR, { recursive: true });

console.log("3/5 Compiling server...");
const serverBuild = $`bun build --compile --minify --target=bun server/index.ts --outfile=dist/zero-agent --external=../web/src/index.html 2>&1 | grep -E "compile|bundle|minify|error"`.nothrow();

console.log("4/5 Building companion...");
const companionBuild = $`cd companion && bunx electrobun build 2>&1`.nothrow();

console.log("5/5 Building desktop app...");
const desktopBuild = $`cd desktop && bunx electrobun build 2>&1`.nothrow();

await Promise.all([serverBuild, companionBuild, desktopBuild]);

// Clean up generated files
await $`rm -rf ${GENERATED}`;

// Step 6: Bundle server binary + companion app into the desktop app
console.log("6/6 Bundling desktop app...");
const desktopAppDir = (await $`ls -d desktop/build/*/`.text()).trim();
const desktopAppName = (await $`ls ${desktopAppDir}`.text()).trim();
const resourcesDir = join(desktopAppDir, desktopAppName, "Contents", "Resources");

// Copy compiled server binary
await $`cp dist/zero-agent ${resourcesDir}/zero-agent`;

// Copy companion .app bundle
const companionBuildDir = (await $`ls -d companion/build/*/`.text()).trim();
const companionAppName = (await $`ls ${companionBuildDir}`.text()).trim();
await $`cp -R ${join(companionBuildDir, companionAppName)} ${join(resourcesDir, "zero-agent-companion.app")}`;

// Set DESKTOP_PRODUCTION in the desktop app's Info.plist environment
// (Electrobun reads env from the process, so we rely on the launcher or wrapper to set it)

const serverSize = ((await Bun.file("dist/zero-agent").size) / 1024 / 1024).toFixed(1);
console.log(`\nDone:`);
console.log(`  dist/zero-agent  (${serverSize} MB)`);
console.log(`  companion/build/ (electrobun app)`);
console.log(`  desktop/build/   (electrobun desktop app — bundled with server + companion)`);
