/**
 * System-prompt builder, bundled-resource paths, and per-turn `.pi/`
 * inspection scaffolding for the in-process Pi agent.
 *
 * Pi itself no longer reads anything from `<project>/.pi/` — we wire
 * SettingsManager/SessionManager in-memory and feed extensions in via
 * factories. The `.pi/` folder is now purely for human inspection: it
 * lets developers `cat`/`ls` the bundled SDK source, agent prompts, and
 * the effective system prompt without diving into node_modules. The
 * project-sandbox extension denies *writes* to `.pi/`, so the agent can
 * read these but can't tamper with them.
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
import { resolveZeroPackageRoot, resolveZeroSdkDir } from "./zero-cli.ts";

export const DEFAULT_SYSTEM_PROMPT = `You are Zero, a general-purpose assistant running inside the Zero web app, working in a sandboxed project workspace.

The \`zero\` CLI and SDK are installed by default: web search/fetch, browser control, image generation, tasks (scheduled/event/script triggers), credentials, apps, sending messages to the user, LLM calls, and embeddings/search.

`;

/** Where the bundled skill definitions live (one subdir per skill). */
export function defaultSkillsDir(): string {
  return path.join(resolveZeroPackageRoot(), "skills");
}

/** Where the bundled subagent definitions live. */
export function defaultAgentsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "extensions", "subagent", "default-agents");
}

function ensureSymlink(link: string, target: string): void {
  if (existsSync(link)) {
    try {
      if (readlinkSync(link) === target) return;
    } catch {
      // Not a symlink — replace.
    }
    unlinkSync(link);
  }
  mkdirSync(path.dirname(link), { recursive: true });
  symlinkSync(target, link);
}

function writeIfChanged(file: string, content: string): void {
  if (existsSync(file)) {
    try {
      if (readFileSync(file, "utf-8") === content) return;
    } catch {
      // Unreadable — fall through and overwrite.
    }
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, "utf-8");
}

/**
 * Idempotently materialize `<projectDir>/.pi/` for human inspection:
 *
 *   .pi/SYSTEM.md      — effective system prompt for the turn
 *   .pi/zero-sdk       — symlink to the bundled SDK source dir
 *   .pi/agents/*.md    — symlinks to bundled subagent prompts
 *
 * Pi never reads these; they're a transparency surface for the developer.
 * The agent itself can read them (they're under projectDir) but cannot
 * modify them (project-sandbox denies writes to `.pi/`).
 */
export function materializePiInspection(opts: {
  projectDir: string;
  systemPrompt: string;
}): void {
  const piDir = path.join(opts.projectDir, ".pi");
  mkdirSync(piDir, { recursive: true });

  writeIfChanged(path.join(piDir, "SYSTEM.md"), opts.systemPrompt);

  try {
    ensureSymlink(path.join(piDir, "zero-sdk"), resolveZeroSdkDir());
  } catch {
    // SDK not built yet — skip; agent inspection just won't see it.
  }

  const agentsDir = path.join(piDir, "agents");
  mkdirSync(agentsDir, { recursive: true });
  const srcAgents = defaultAgentsDir();
  try {
    for (const name of readdirSync(srcAgents)) {
      if (!name.endsWith(".md")) continue;
      ensureSymlink(path.join(agentsDir, name), path.join(srcAgents, name));
    }
  } catch {
    // No bundled agents shipped — leave .pi/agents/ empty for the user.
  }
}

/**
 * Compose the system prompt for a turn. Project-level prompt is appended
 * to the default — the default carries baseline behavior (zero CLI/SDK
 * affordances) that the per-project prompt should extend, not replace.
 */
export function buildSystemPrompt(projectSystemPrompt?: string): string {
  const extra = projectSystemPrompt?.trim();
  if (!extra) return DEFAULT_SYSTEM_PROMPT;
  return DEFAULT_SYSTEM_PROMPT + extra;
}
