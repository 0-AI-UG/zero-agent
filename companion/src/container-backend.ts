import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import type { ExecutionBackend } from "./workspace.ts";
import { readCapped } from "./workspace-utils.ts";

export type RuntimeStatus =
  | { ready: true }
  | { ready: false; installed: boolean; canSetup: boolean; needsWsl: boolean };

const IMAGE = "zero-workspace:latest";
const MAX_OUTPUT = 1_048_576; // 1 MB

const DOCKERFILE = `
FROM oven/bun:latest

RUN apt-get update && apt-get install -y --no-install-recommends \\
    curl git jq zip unzip imagemagick ca-certificates \\
    && curl -LsSf https://astral.sh/uv/install.sh | sh \\
    && mv /root/.local/bin/uv /usr/local/bin/uv \\
    && rm -rf /var/lib/apt/lists/*

ENV UV_PYTHON_PREFERENCE=only-managed
WORKDIR /workspace
`.trim();

const IS_WINDOWS = os.platform() === "win32";

// GUI apps on macOS inherit a minimal PATH that often excludes /usr/local/bin,
// /opt/homebrew/bin, etc. Augment PATH so we can find docker, brew, colima, etc.
if (os.platform() === "darwin") {
  const extra = ["/usr/local/bin", "/opt/homebrew/bin", "/opt/orbstack/bin"];
  const current = process.env.PATH ?? "";
  const missing = extra.filter((p) => !current.split(":").includes(p));
  if (missing.length) {
    process.env.PATH = [...missing, current].join(":");
  }
}

/** Progress callback for setup steps. */
export type SetupProgressFn = (step: string, detail?: string) => void;

// ── Detection ──

function isInstalled(): boolean {
  try {
    return Bun.spawnSync(["docker", "--version"], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;
  } catch {
    return false;
  }
}

function isDaemonRunning(): boolean {
  try {
    return Bun.spawnSync(["docker", "info"], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;
  } catch {
    return false;
  }
}

/** Check whether WSL2 is available (Windows only). */
export function isWslAvailable(): boolean {
  if (!IS_WINDOWS) return true;
  try {
    return Bun.spawnSync(["wsl", "--status"], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;
  } catch {
    return false;
  }
}

/** Detect runtime status. */
export function detectRuntime(): RuntimeStatus {
  if (!isInstalled()) {
    return { ready: false, installed: false, canSetup: true, needsWsl: IS_WINDOWS && !isWslAvailable() };
  }

  if (!isDaemonRunning()) {
    // Docker is installed but not running — user needs to start Docker Desktop
    return { ready: false, installed: true, canSetup: true, needsWsl: false };
  }

  return { ready: true };
}

// ── Install ──

function hasBrew(): boolean {
  return Bun.spawnSync(["which", "brew"], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;
}

function hasColima(): boolean {
  return Bun.spawnSync(["which", "colima"], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;
}

function isColimaRunning(): boolean {
  try {
    const proc = Bun.spawnSync(["colima", "status"], { stdout: "pipe", stderr: "pipe" });
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

/** Run a command, streaming output to progress. Returns exit code. */
async function runWithProgress(cmd: string[], progress: SetupProgressFn): Promise<number> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const stdoutDone = streamLines(proc.stdout as ReadableStream<Uint8Array>, (line) => {
    progress("output", line);
  });
  const stderrDone = streamLines(proc.stderr as ReadableStream<Uint8Array>, (line) => {
    progress("output", line);
  });
  await Promise.all([stdoutDone, stderrDone]);
  return await proc.exited;
}

/** Try to start the Docker daemon on macOS (Colima or Docker Desktop / OrbStack). */
async function startDockerMacOS(progress: SetupProgressFn): Promise<{ ok: boolean; error?: string }> {
  try {
    if (!isInstalled()) {
      return {
        ok: false,
        error: "Docker not found. Please install Docker via OrbStack, Docker Desktop, or `brew install docker` in your terminal, then retry.",
      };
    }

    // Docker is installed but daemon not running — try to start it
    if (hasColima() && !isColimaRunning()) {
      progress("Starting Colima");
      const exit = await runWithProgress(["colima", "start"], progress);
      if (exit === 0 && isDaemonRunning()) {
        progress("Docker is ready");
        return { ok: true };
      }
    }

    // Try launching Docker Desktop / OrbStack via `open`
    progress("Starting Docker");
    Bun.spawn(["open", "-a", "Docker"], { stdout: "pipe", stderr: "pipe" });

    progress("Waiting for Docker daemon");
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      if (isDaemonRunning()) {
        progress("Docker is ready");
        return { ok: true };
      }
      progress("output", `Waiting for daemon (${(i + 1) * 2}s)`);
    }

    return { ok: false, error: "Docker daemon did not start. Please start it manually and retry." };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Install or start Docker via platform-appropriate means. */
export async function installDocker(onProgress?: SetupProgressFn): Promise<{ ok: boolean; error?: string }> {
  const progress = onProgress ?? (() => {});
  const platform = os.platform();

  if (platform === "darwin") {
    return startDockerMacOS(progress);
  }

  let cmd: string[];
  if (platform === "linux") {
    const hasApt = Bun.spawnSync(["which", "apt-get"], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;
    if (hasApt) {
      progress("Installing via apt");
      cmd = ["sudo", "apt-get", "install", "-y", "docker.io"];
    } else {
      progress("Installing via dnf");
      cmd = ["sudo", "dnf", "install", "-y", "docker"];
    }
  } else if (platform === "win32") {
    progress("Installing via winget");
    cmd = ["winget", "install", "-e", "--id", "Docker.DockerDesktop", "--accept-source-agreements"];
  } else {
    return { ok: false, error: `Unsupported platform: ${platform}` };
  }

  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    const stdoutDone = streamLines(proc.stdout as ReadableStream<Uint8Array>, (line) => {
      progress("output", line);
    });
    const stderrDone = streamLines(proc.stderr as ReadableStream<Uint8Array>, (line) => {
      progress("output", line);
    });
    await Promise.all([stdoutDone, stderrDone]);
    const exitCode = await proc.exited;
    if (exitCode !== 0) return { ok: false, error: `Install failed with exit code ${exitCode}` };
    progress("Docker installed");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Trigger WSL2 installation (requires admin, will prompt for reboot). */
export async function installWsl(): Promise<{ ok: boolean; error?: string }> {
  try {
    const proc = Bun.spawn(["wsl", "--install", "--no-distribution"], { stdout: "pipe", stderr: "pipe" });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      return { ok: false, error: stderr.trim() || `wsl --install exited with code ${exitCode}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Setup ──

async function streamLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    full += chunk;
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    for (const line of lines) {
      if (line.trim()) onLine(line.trim());
    }
  }
  if (buffer.trim()) onLine(buffer.trim());
  return full;
}

/**
 * Full setup: install Docker if needed, ensure daemon is running.
 */
export async function setupDocker(onProgress?: SetupProgressFn): Promise<{ ok: boolean; error?: string }> {
  const progress = onProgress ?? (() => {});

  if (isDaemonRunning()) return { ok: true };
  return installDocker(progress);
}

/** Prepare Docker for use — start Colima/Docker Desktop if daemon is not running. */
export async function prepareRuntime(onProgress?: SetupProgressFn): Promise<void> {
  if (isDaemonRunning()) return;

  const progress = onProgress ?? (() => {});

  if (os.platform() === "darwin" && hasColima() && !isColimaRunning()) {
    progress("Starting Colima");
    const exit = await runWithProgress(["colima", "start"], progress);
    if (exit === 0 && isDaemonRunning()) return;
  }

  if (!isDaemonRunning()) {
    const result = await setupDocker(onProgress);
    if (!result.ok) throw new Error(result.error ?? "Failed to start Docker");
  }
}

// ── Resource inspection ──

export interface DockerContainer {
  id: string;
  name: string;
  image: string;
  state: string;
  created: string;
}

export interface DockerImage {
  id: string;
  repository: string;
  tag: string;
  created: string;
}

export interface DockerResources {
  containers: DockerContainer[];
  images: DockerImage[];
}

function parseJsonOutput<T>(args: string[]): T[] {
  const proc = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) return [];
  const text = new TextDecoder().decode(proc.stdout).trim();
  if (!text) return [];
  // Docker outputs one JSON object per line (NDJSON), not a JSON array
  const results: T[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { results.push(JSON.parse(trimmed)); } catch {}
  }
  return results;
}

export function getDockerResources(): DockerResources {
  // Containers
  const rawContainers = parseJsonOutput<any>(["docker", "ps", "-a", "--filter", "name=workspace-", "--format", "{{json .}}"]);
  const containers: DockerContainer[] = rawContainers.map((c: any) => ({
    id: (c.ID || c.Id || "").slice(0, 12),
    name: (c.Names || c.Name || "").replace(/^\//, ""),
    image: c.Image || "",
    state: c.State || "",
    created: c.CreatedAt || c.Created || "",
  }));

  // Images — only the workspace image
  const rawImages = parseJsonOutput<any>(["docker", "images", "zero-workspace", "--format", "{{json .}}"]);
  const images: DockerImage[] = rawImages.map((img: any) => ({
    id: (img.ID || img.Id || "").slice(0, 12),
    repository: img.Repository || "<none>",
    tag: img.Tag || "latest",
    created: img.CreatedAt || img.Created || "",
  }));

  return { containers, images };
}

export async function removeContainer(id: string): Promise<{ ok: boolean; error?: string }> {
  const proc = Bun.spawn(["docker", "rm", "-f", id], { stdout: "pipe", stderr: "pipe" });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    return { ok: false, error: stderr.trim() };
  }
  return { ok: true };
}

export async function removeImage(id: string): Promise<{ ok: boolean; error?: string }> {
  const proc = Bun.spawn(["docker", "rmi", "-f", id], { stdout: "pipe", stderr: "pipe" });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    return { ok: false, error: stderr.trim() };
  }
  return { ok: true };
}

export async function pruneAll(): Promise<{ ok: boolean; error?: string }> {
  // Only remove companion containers (named workspace-*)
  const rawContainers = parseJsonOutput<any>(["docker", "ps", "-a", "--format", "{{json .}}"]);
  for (const c of rawContainers) {
    const name = c.Names || c.Name || "";
    const state = c.State || "";
    if (name.startsWith("workspace-") && state !== "running") {
      const id = c.ID || c.Id || "";
      if (id) {
        const proc = Bun.spawn(["docker", "rm", "-f", id], { stdout: "pipe", stderr: "pipe" });
        await proc.exited;
      }
    }
  }

  // Only remove the companion workspace image
  const rawImages = parseJsonOutput<any>(["docker", "images", "--format", "{{json .}}"]);
  for (const img of rawImages) {
    const repo = img.Repository || "";
    if (repo === "zero-workspace") {
      const id = img.ID || img.Id || "";
      if (id) {
        const proc = Bun.spawn(["docker", "rmi", "-f", id], { stdout: "pipe", stderr: "pipe" });
        await proc.exited;
      }
    }
  }

  return { ok: true };
}

// ── Backend ──

export class ContainerBackend implements ExecutionBackend {
  private containers = new Map<string, string>();
  private imageReady = false;
  private imageBuilding: Promise<void> | null = null;

  private async ensureImage(): Promise<void> {
    if (this.imageReady) return;
    if (this.imageBuilding) return this.imageBuilding;

    this.imageBuilding = (async () => {
      const check = Bun.spawnSync(["docker", "image", "inspect", IMAGE], {
        stdout: "pipe",
        stderr: "pipe",
      });
      if (check.exitCode === 0) {
        this.imageReady = true;
        return;
      }

      const build = Bun.spawn(
        ["docker", "build", "-t", IMAGE, "-"],
        { stdout: "pipe", stderr: "pipe", stdin: "pipe" },
      );
      build.stdin.write(DOCKERFILE);
      build.stdin.end();
      const exitCode = await build.exited;
      if (exitCode !== 0) {
        const stderr = await new Response(build.stderr).text();
        throw new Error(`Failed to build workspace image: ${stderr}`);
      }
      this.imageReady = true;
    })();

    return this.imageBuilding;
  }

  async initWorkspace(workspaceId: string, dir: string): Promise<void> {
    await this.ensureImage();

    const containerName = `workspace-${workspaceId}`;

    Bun.spawnSync(["docker", "rm", "-f", containerName], {
      stdout: "ignore",
      stderr: "ignore",
    });

    const proc = Bun.spawn(
      [
        "docker", "run", "-d",
        "--name", containerName,
        "-v", `${dir}:/workspace`,
        "--workdir", "/workspace",
        IMAGE,
        "sleep", "infinity",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const containerId = (await new Response(proc.stdout).text()).trim();
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`Failed to start workspace container: ${stderr}`);
    }
    this.containers.set(workspaceId, containerId);
  }

  async runCommand(
    workspaceId: string,
    _dir: string,
    command: string,
    timeout: number,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const containerId = this.containers.get(workspaceId);
    if (!containerId) throw new Error("Container not found for workspace");

    const proc = Bun.spawn(
      ["docker", "exec", containerId, "bash", "-c", command],
      { stdout: "pipe", stderr: "pipe" },
    );
    const timer = setTimeout(() => {
      proc.kill();
    }, timeout);
    const [stdout, stderr] = await Promise.all([
      readCapped(proc.stdout, MAX_OUTPUT),
      readCapped(proc.stderr, MAX_OUTPUT),
    ]);
    clearTimeout(timer);
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  }

  async destroyWorkspace(workspaceId: string): Promise<void> {
    const containerId = this.containers.get(workspaceId);
    if (!containerId) return;
    this.containers.delete(workspaceId);
    Bun.spawn(["docker", "rm", "-f", containerId], {
      stdout: "ignore",
      stderr: "ignore",
    });
  }
}
