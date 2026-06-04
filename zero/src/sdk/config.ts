/**
 * Local companion config — persisted to ~/.zero/config.json on the user's
 * own machine. This is what turns the in-container `zero` CLI into a laptop
 * companion: when this file holds a base URL + companion token, the CLI runs
 * in "remote mode" and talks to the user's zero server over the public
 * /api/* surface instead of the per-turn unix socket.
 *
 * The file holds a long-lived companion secret, so it is written 0600.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  chmodSync,
} from "node:fs";
import { ZeroError } from "./errors.ts";

export interface CompanionConfig {
  /** Base URL of the zero server, e.g. https://zero.example.com (no trailing slash). */
  baseUrl: string;
  /** Companion token (cmp_...) — project-scoped bearer credential. */
  token: string;
  /** Project this companion is bound to. Companion tokens are single-project. */
  projectId: string;
  /** Human label for the bound project, cached for display. */
  projectName?: string;
}

function configDir(): string {
  return process.env.ZERO_CONFIG_DIR || join(homedir(), ".zero");
}

/**
 * The zero home directory (`~/.zero`, or `$ZERO_CONFIG_DIR`). This is where the
 * installer drops `bin/zero`, and where the companion writes the Zero Companion
 * browser extension (`<home>/extension/`) that `zero browser connect` side-loads
 * into the user's Chrome.
 */
export function zeroHomeDir(): string {
  return configDir();
}

function configPath(): string {
  return join(configDir(), "config.json");
}

/** True if a companion config is present (i.e. the CLI should run in remote mode). */
export function hasConfig(): boolean {
  return existsSync(configPath());
}

export function loadConfig(): CompanionConfig | null {
  const path = configPath();
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<CompanionConfig>;
    if (!parsed.baseUrl || !parsed.token || !parsed.projectId) return null;
    return parsed as CompanionConfig;
  } catch {
    return null;
  }
}

/** Load config or throw a friendly error pointing the user at `zero login`. */
export function requireConfig(): CompanionConfig {
  const cfg = loadConfig();
  if (!cfg) {
    throw new ZeroError(
      "not_logged_in",
      "Not logged in. Run `zero login --url <server>` first.",
    );
  }
  return cfg;
}

export function saveConfig(cfg: CompanionConfig): void {
  const dir = configDir();
  mkdirSync(dir, { recursive: true });
  const path = configPath();
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  // Re-assert perms in case the file already existed with looser bits.
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best-effort on platforms without POSIX perms.
  }
}

export function clearConfig(): void {
  const path = configPath();
  if (existsSync(path)) {
    // Overwrite the file in place so the old token no longer sits on disk.
    // `loadConfig` treats the resulting `{}` as logged-out (missing fields).
    writeFileSync(path, "{}\n", { mode: 0o600 });
  }
}

export function configFilePath(): string {
  return configPath();
}

function deviceIdPath(): string {
  return join(configDir(), "device-id");
}

let cachedDeviceId: string | null = null;

/**
 * Stable per-machine identifier for this companion install, persisted to
 * `~/.zero/device-id`. The server uses it to tell "the same computer
 * reconnecting" apart from "a different computer taking over the link": a new
 * connection carrying the same deviceId is a silent hand-off (the prior one on
 * this machine quietly steps aside), not the cross-machine takeover that warns
 * the user. Kept separate from the auth config so it survives logout — a
 * re-login from the same machine keeps its identity.
 */
export function getOrCreateDeviceId(): string {
  if (cachedDeviceId) return cachedDeviceId;
  const path = deviceIdPath();
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (existing) return (cachedDeviceId = existing);
  } catch {
    // Not created yet — fall through and mint one.
  }
  const id = randomUUID();
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(path, id + "\n", { mode: 0o600 });
  return (cachedDeviceId = id);
}
