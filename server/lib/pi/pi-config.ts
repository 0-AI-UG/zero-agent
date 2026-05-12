/**
 * Materialize <project>/.pi/settings.json before each Pi turn. Zero owns
 * this file; manual user edits will be overwritten on the next turn (file
 * is regenerated when content hash changes).
 *
 * Sandbox config used to live in <project>/.pi/sandbox.json for the
 * upstream sandbox extension. We've replaced that extension with our own
 * project-sandbox extension which derives its config from `process.cwd()`
 * directly, so sandbox.json is no longer written.
 *
 * Also resolves the `pi` binary so spawn() can launch it from the
 * project working directory regardless of how this server is invoked
 * (node, tsx, bun-compiled binary).
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { sha256Hex } from "@/lib/utils/hash.ts";
import { resolveZeroSdkPath } from "./zero-cli.ts";

export interface PiConfigInputs {
  projectDir: string;
  /** Pi-AI model id (already resolved). */
  modelId: string;
  /** Pi provider id, e.g. "openrouter". */
  provider: string;
  /** Optional extra extensions to enable. Each item must be an absolute path. */
  extraExtensions?: string[];
}

const SYSTEM_PROMPT = `You are Zero, a general-purpose assistant running inside the Zero web app. The cwd is a shared project workspace; treat it as scratch space.

For anything beyond your built-in tools (read/write/edit/bash/grep/find/ls), use the \`zero\` CLI: web search/fetch, browser control, image generation, scheduling, credentials, apps (\`zero apps create\` allocates a port + URL for a server you run), sending messages to the user, LLM calls, and embeddings/search. Run \`zero <group> --help\` for the authoritative interface.

For programmatic / multi-step composition, run a bun script that imports the same surface: \`import { web, browser, image, ... } from "./.pi/zero-sdk.mjs"\`. Use this when you need to chain calls, pass structured data between them, or loop — otherwise prefer the CLI.

You can delegate work to subagents via the \`subagent\` tool. Each subagent runs in its own isolated context window — use them to keep this conversation focused. Available agents:
- \`explore\` — read-only codebase recon; returns compressed findings with file paths and excerpts.
- \`plan\` — read-only planning; turns context + a requirement into a concrete implementation plan.
- \`agent\` — general-purpose, full tool access; for self-contained tasks that would otherwise eat this context.

Modes: \`{ agent, task }\` (single), \`{ tasks: [...] }\` (parallel, up to 8), \`{ chain: [...] }\` (sequential, use \`{previous}\` to pass output forward). Prefer subagents when a task involves a lot of reading/exploration whose details you don't need to keep around.
`;

function projectSandboxExtensionPath(): string {
  // Co-located with this file: server/lib/pi/extensions/project-sandbox/
  const here = path.dirname(fileURLToPath(import.meta.url));
  const ext = path.join(here, "extensions", "project-sandbox");
  if (!existsSync(ext)) {
    throw new Error(`project-sandbox extension not found at ${ext}`);
  }
  return ext;
}

function subagentExtensionPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const ext = path.join(here, "extensions", "subagent");
  if (!existsSync(ext)) {
    throw new Error(`subagent extension not found at ${ext}`);
  }
  return ext;
}

/** Where the bundled agent definitions live. */
function defaultAgentsDir(): string {
  return path.join(subagentExtensionPath(), "default-agents");
}

function buildSettings(opts: PiConfigInputs) {
  const extensions = [
    projectSandboxExtensionPath(),
    subagentExtensionPath(),
    ...(opts.extraExtensions ?? []),
  ];
  return {
    defaultProvider: opts.provider,
    defaultModel: opts.modelId,
    extensions,
    skills: ["./skills"],
    sessionDir: "../.pi-sessions",
    quietStartup: true,
    compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
    retry: { enabled: true, maxRetries: 3 },
  };
}

function ensureSymlink(link: string, target: string): void {
  if (existsSync(link)) {
    try {
      if (readlinkSync(link) === target) return;
    } catch {
      // Not a symlink — fall through to replace.
    }
    unlinkSync(link);
  }
  mkdirSync(path.dirname(link), { recursive: true });
  symlinkSync(target, link);
}

function writeIfChanged(file: string, content: string): void {
  if (existsSync(file)) {
    const cur = readFileSync(file, "utf-8");
    if (sha256Hex(Buffer.from(cur)) === sha256Hex(Buffer.from(content))) return;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, "utf-8");
}

/**
 * Idempotently writes <project>/.pi/settings.json and .pi/SYSTEM.md.
 * Returns the directory paths Pi will read from.
 */
export function ensurePiConfig(opts: PiConfigInputs): {
  configDir: string;
  skillsDir: string;
} {
  const configDir = path.join(opts.projectDir, ".pi");
  const skillsDir = path.join(configDir, "skills");
  mkdirSync(skillsDir, { recursive: true });

  const settings = buildSettings(opts);
  writeIfChanged(
    path.join(configDir, "settings.json"),
    JSON.stringify(settings, null, 2) + "\n",
  );

  writeIfChanged(path.join(configDir, "SYSTEM.md"), SYSTEM_PROMPT);

  ensureSymlink(path.join(configDir, "zero-sdk.mjs"), resolveZeroSdkPath());

  // Materialize bundled subagent definitions into <project>/.pi/agents/*.md
  // so the subagent extension's project-scope discovery picks them up.
  // User-added .md files in this directory coexist with the symlinks.
  const agentsDir = path.join(configDir, "agents");
  mkdirSync(agentsDir, { recursive: true });
  const srcAgents = defaultAgentsDir();
  for (const name of readdirSync(srcAgents)) {
    if (!name.endsWith(".md")) continue;
    ensureSymlink(path.join(agentsDir, name), path.join(srcAgents, name));
  }

  return { configDir, skillsDir };
}

/**
 * Resolve how to invoke the `pi` binary. Mirrors the pattern used by
 * the subagent example so the same logic works under node, tsx, and a
 * bun-compiled host.
 */
export function getPiInvocation(args: string[]): {
  command: string;
  args: string[];
} {
  const require = createRequire(import.meta.url);
  // Prefer the resolved CLI entry from node_modules — most reliable.
  try {
    const cli = require.resolve("@mariozechner/pi-coding-agent/dist/cli.js");
    return { command: process.execPath, args: [cli, ...args] };
  } catch {
    // fall through
  }
  // Fall back to a `pi` on PATH.
  return { command: "pi", args };
}

/** Test-only: peek at the resolved sandbox extension path. */
export function _projectSandboxExtensionPath(): string {
  return projectSandboxExtensionPath();
}

