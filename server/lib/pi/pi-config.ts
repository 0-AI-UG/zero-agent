/**
 * Materialize <project>/.pi/settings.json and <project>/.pi/sandbox.json
 * before each Pi turn. Zero owns these files; manual user edits will be
 * overwritten on the next turn (file is regenerated when content hash
 * changes).
 *
 * Also resolves the `pi` binary so spawn() can launch it from the
 * project working directory regardless of how this server is invoked
 * (node, tsx, bun-compiled binary).
 */
import {
  existsSync,
  mkdirSync,
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

const SANDBOX_DENY_WRITE_RELATIVE = [".pi", ".pi-sessions", ".git-snapshots"];

const SYSTEM_PROMPT = `You are Zero, a general-purpose assistant running inside the Zero web app. The cwd is a shared project workspace; treat it as scratch space.

For anything beyond your built-in tools (read/write/edit/bash/grep/find/ls), use the \`zero\` CLI: web search/fetch, browser control, image generation, scheduling, credentials, apps (\`zero apps create\` allocates a port + URL for a server you run), sending messages to the user, LLM calls, and embeddings/search. Run \`zero <group> --help\` for the authoritative interface.

For programmatic / multi-step composition, run a bun script that imports the same surface: \`import { web, browser, image, ... } from "./.pi/zero-sdk.mjs"\`. Use this when you need to chain calls, pass structured data between them, or loop — otherwise prefer the CLI.
`;

// Upstream defaults from examples/extensions/sandbox/index.ts. The extension
// merges by shallow-replace per field, so our project-local override needs
// to spell these out or we lose the protection.
const UPSTREAM_DENY_READ = ["~/.ssh", "~/.aws", "~/.gnupg"];
const UPSTREAM_DENY_WRITE_GLOBS = [".env", ".env.*", "*.pem", "*.key"];

function vanillaSandboxExtensionPath(): string {
  // The package's "exports" field only declares the ESM `import` condition,
  // so CJS `require.resolve` (used by createRequire) fails for both the main
  // entry and `./package.json`. Use ESM `import.meta.resolve` instead — it
  // honors the import condition — and walk up to the package root.
  const entryUrl = import.meta.resolve("@mariozechner/pi-coding-agent");
  const entry = fileURLToPath(entryUrl);
  const root = path.dirname(path.dirname(entry));
  const sandbox = path.join(root, "examples", "extensions", "sandbox");
  if (!existsSync(sandbox)) {
    throw new Error(`pi sandbox extension not found at ${sandbox}`);
  }
  return sandbox;
}

function projectFsExtensionPath(): string {
  // Co-located with this file: server/lib/pi/extensions/project-fs/
  const here = path.dirname(fileURLToPath(import.meta.url));
  const ext = path.join(here, "extensions", "project-fs");
  if (!existsSync(ext)) {
    throw new Error(`project-fs extension not found at ${ext}`);
  }
  return ext;
}

function buildSettings(opts: PiConfigInputs) {
  const extensions = [
    vanillaSandboxExtensionPath(),
    projectFsExtensionPath(),
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

function buildSandboxConfig(projectDir: string) {
  // The bash sandbox is disabled. Two reasons:
  //  1. On Linux it would `bwrap --unshare-net` the bash subprocess, putting
  //     it in a separate netns. The in-process CLI server is reached via
  //     `ZERO_PROXY_URL=http://127.0.0.1:<port>` and Bun/Node's fetch
  //     bypasses HTTP_PROXY for loopback — so the call can't reach the
  //     namespace-local 127.0.0.1, and the agent's `zero` CLI breaks.
  //  2. We already isolate Pi's read/write/edit/grep/find/ls via the
  //     project-fs extension. Bash itself is contained by the Docker
  //     boundary in production; in dev the sandbox extension was already
  //     failing to initialize anyway (its schema rejects `allowedDomains:
  //     ["*"]`).
  //
  // The fields below are kept for documentation / future re-enable —
  // ignored while `enabled: false`.
  return {
    enabled: false,
    network: { allowedDomains: ["*"], deniedDomains: [] },
    filesystem: {
      denyRead: [...UPSTREAM_DENY_READ],
      allowWrite: [projectDir, "/tmp"],
      denyWrite: [
        ...SANDBOX_DENY_WRITE_RELATIVE.map((p) => path.join(projectDir, p)),
        ...UPSTREAM_DENY_WRITE_GLOBS,
      ],
    },
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
 * Idempotently writes <project>/.pi/settings.json and .pi/sandbox.json.
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

  const sandbox = buildSandboxConfig(opts.projectDir);
  writeIfChanged(
    path.join(configDir, "sandbox.json"),
    JSON.stringify(sandbox, null, 2) + "\n",
  );

  writeIfChanged(path.join(configDir, "SYSTEM.md"), SYSTEM_PROMPT);

  ensureSymlink(path.join(configDir, "zero-sdk.mjs"), resolveZeroSdkPath());

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
export function _vanillaSandboxExtensionPath(): string {
  return vanillaSandboxExtensionPath();
}

