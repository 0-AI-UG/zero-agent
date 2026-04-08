#!/usr/bin/env node
/**
 * Builds the full application:
 * 1. Builds the web frontend into web/dist/
 * 2. Embeds the built assets into a TS module for the Node server to serve
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync, rmSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = join(__dirname, "web/dist");
const GENERATED = join(__dirname, "server/_generated");

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

function run(cmd: string, opts?: { cwd?: string }) {
  console.log(`  $ ${cmd}`);
  execSync(cmd, { stdio: "inherit", ...opts });
}

// Step 1: Build frontend
console.log("1/3 Building frontend...");
run("bun run build", { cwd: join(__dirname, "web") });
const distFiles = readdirSync(DIST_DIR, { recursive: true })
  .map(String)
  .filter((f) => !f.endsWith(".map"));
console.log(`    ${distFiles.length} files`);

// Step 2: Generate embedded assets module
console.log("2/3 Embedding assets...");
mkdirSync(GENERATED, { recursive: true });

const entries: string[] = [];
for (const file of distFiles) {
  const fullPath = join(DIST_DIR, file);
  const stat = statSync(fullPath);
  if (stat.isDirectory()) continue;
  const content = readFileSync(fullPath);
  const ext = extname(file);
  const mime = MIME_TYPES[ext] ?? "application/octet-stream";
  const isHashed = /[-\.][a-z0-9]{8,}\.\w+$/.test(file);
  const key = "/" + file.replace(/\\/g, "/");
  entries.push(
    `  "${key}": { data: Buffer.from("${content.toString("base64")}", "base64"), mime: "${mime}", immutable: ${isHashed} }`,
  );
}

writeFileSync(
  join(GENERATED, "assets.ts"),
  `// Auto-generated — do not edit\nexport const assets: Record<string, { data: Buffer; mime: string; immutable: boolean }> = {\n${entries.join(",\n")}\n};\n`,
);

console.log("3/3 Assets embedded.");

// Clean up generated files after use
// rmSync(GENERATED, { recursive: true, force: true });

const serverSize = (distFiles.reduce((sum, f) => {
  const s = statSync(join(DIST_DIR, f));
  return sum + (s.isFile() ? s.size : 0);
}, 0) / 1024 / 1024).toFixed(1);

console.log(`\nDone:`);
console.log(`  web/dist/              (${serverSize} MB)`);
console.log(`  server/_generated/     (embedded assets)`);
