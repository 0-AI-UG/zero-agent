import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import type { Logger } from "./logger.ts";
import { walkDir, buildSnapshot, snapshotDiff, type Snapshot } from "./workspace-utils.ts";

export interface ExecutionBackend {
  initWorkspace(workspaceId: string, dir: string): Promise<void>;
  runCommand(workspaceId: string, dir: string, command: string, timeout: number): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  destroyWorkspace(workspaceId: string): Promise<void>;
}

const WORKSPACE_ROOT = path.join(os.homedir(), ".companion", "workspaces");
const IDLE_TIMEOUT = 10 * 60 * 1000; // 10 minutes
const DEFAULT_COMMAND_TIMEOUT = 60_000;
const DOWNLOAD_CONCURRENCY = 10;

function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 12) : id;
}

interface WorkspaceState {
  lastUsedAt: number;
  snapshot: Snapshot;
  dir: string;
}

export class WorkspaceManager {
  private workspaces = new Map<string, WorkspaceState>();
  private locks = new Map<string, Promise<void>>();
  private reaper: ReturnType<typeof setInterval>;
  private log: Logger;
  private backend: ExecutionBackend;

  constructor(config: { logger: Logger; backend: ExecutionBackend }) {
    this.log = config.logger;
    this.backend = config.backend;
    this.reaper = setInterval(() => {
      const now = Date.now();
      for (const [id, state] of this.workspaces) {
        if (now - state.lastUsedAt > IDLE_TIMEOUT) {
          this.log.info(`[workspace] Reaping idle workspace ${shortId(id)} (idle ${Math.round((now - state.lastUsedAt) / 1000)}s)`);
          this.destroyWorkspace(id);
        }
      }
    }, 60_000);
  }

  private async withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    let resolve: () => void;
    const next = new Promise<void>(r => { resolve = r; });
    this.locks.set(id, next);
    await prev;
    try { return await fn(); }
    finally { resolve!(); }
  }

  async createWorkspace(workspaceId: string, manifest: Record<string, string>): Promise<void> {
    const sid = shortId(workspaceId);
    const dir = path.join(WORKSPACE_ROOT, workspaceId);
    const fileCount = Object.keys(manifest).length;
    this.log.info(`[workspace] Creating workspace ${sid} with ${fileCount} file(s) in ${dir}`);
    await fs.mkdir(dir, { recursive: true });
    await fs.mkdir(path.join(dir, ".tmp"), { recursive: true });

    const resolvedBase = path.resolve(dir) + path.sep;

    // Download files from manifest in batches
    const entries = Object.entries(manifest);
    let downloaded = 0;
    for (let i = 0; i < entries.length; i += DOWNLOAD_CONCURRENCY) {
      const batch = entries.slice(i, i + DOWNLOAD_CONCURRENCY);
      await Promise.all(batch.map(async ([relativePath, presignedUrl]) => {
        const filePath = path.join(dir, relativePath);
        // Path traversal check
        if (!path.resolve(filePath).startsWith(resolvedBase)) {
          this.log.warn(`[workspace] ${sid}: skipping manifest entry "${relativePath}" (path escapes workspace)`);
          return;
        }
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        this.log.debug(`[workspace] ${sid}: downloading ${relativePath}`);
        const res = await fetch(presignedUrl);
        if (!res.ok) {
          throw new Error(`Failed to download ${relativePath}: ${res.status} ${res.statusText}`);
        }
        const buffer = await res.arrayBuffer();
        await Bun.write(filePath, buffer);
        downloaded++;
      }));
      if (fileCount > DOWNLOAD_CONCURRENCY) {
        this.log.debug(`[workspace] ${sid}: downloaded ${downloaded}/${fileCount} files`);
      }
    }

    // Take initial snapshot
    const files = await walkDir(dir);
    const snapshot = buildSnapshot(files);

    // Initialize backend
    await this.backend.initWorkspace(workspaceId, dir);

    this.workspaces.set(workspaceId, {
      lastUsedAt: Date.now(),
      snapshot,
      dir,
    });

    this.log.info(`[workspace] Workspace ${sid} ready (${files.length} files in snapshot)`);
  }

  async syncWorkspace(workspaceId: string, manifest: Record<string, string>): Promise<void> {
    return this.withLock(workspaceId, async () => {
      const workspace = this.workspaces.get(workspaceId);
      if (!workspace) throw new Error("Execution environment not found — it may have been cleaned up. Please retry.");
      workspace.lastUsedAt = Date.now();

      const sid = shortId(workspaceId);
      const dir = workspace.dir;
      const resolvedBase = path.resolve(dir) + path.sep;
      const fileCount = Object.keys(manifest).length;
      this.log.info(`[workspace] Syncing workspace ${sid} with ${fileCount} file(s)`);

      const entries = Object.entries(manifest);
      let downloaded = 0;
      for (let i = 0; i < entries.length; i += DOWNLOAD_CONCURRENCY) {
        const batch = entries.slice(i, i + DOWNLOAD_CONCURRENCY);
        await Promise.all(batch.map(async ([relativePath, presignedUrl]) => {
          const filePath = path.join(dir, relativePath);
          if (!path.resolve(filePath).startsWith(resolvedBase)) {
            this.log.warn(`[workspace] ${sid}: skipping sync entry "${relativePath}" (path escapes workspace)`);
            return;
          }
          await fs.mkdir(path.dirname(filePath), { recursive: true });
          this.log.debug(`[workspace] ${sid}: syncing ${relativePath}`);
          const res = await fetch(presignedUrl);
          if (!res.ok) {
            throw new Error(`Failed to download ${relativePath}: ${res.status} ${res.statusText}`);
          }
          const buffer = await res.arrayBuffer();
          await Bun.write(filePath, buffer);
          downloaded++;
        }));
      }

      // Rebuild snapshot after sync
      const files = await walkDir(dir);
      workspace.snapshot = buildSnapshot(files);

      this.log.info(`[workspace] Workspace ${sid} synced (${downloaded} files updated, ${files.length} total in snapshot)`);
    });
  }

  async runCommand(
    workspaceId: string,
    command: string,
    timeout?: number,
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
    changedFiles?: Array<{ path: string; data: string; sizeBytes: number }>;
    deletedFiles?: string[];
  }> {
    return this.withLock(workspaceId, async () => {
      const workspace = this.workspaces.get(workspaceId);
      if (!workspace) throw new Error("Execution environment not found — it may have been cleaned up. Please retry.");
      workspace.lastUsedAt = Date.now();

      const sid = shortId(workspaceId);
      const effectiveTimeout = timeout ?? DEFAULT_COMMAND_TIMEOUT;
      const cmdPreview = command.length > 80 ? command.slice(0, 80) + "..." : command;
      this.log.info(`[workspace] ${sid}: executing \`${cmdPreview}\` (timeout ${effectiveTimeout / 1000}s)`);

      // Run command via backend
      const result = await this.backend.runCommand(workspaceId, workspace.dir, command, effectiveTimeout);

      // Strip absolute workspace paths from output so the agent only sees relative paths
      const wsPrefix = workspace.dir.endsWith("/") ? workspace.dir : workspace.dir + "/";
      result.stdout = result.stdout.replaceAll(wsPrefix, "").replaceAll(workspace.dir, ".");
      result.stderr = result.stderr.replaceAll(wsPrefix, "").replaceAll(workspace.dir, ".");

      this.log.info(`[workspace] ${sid}: command exited with code ${result.exitCode}`);
      if (result.stderr.length > 0) {
        const stderrPreview = result.stderr.length > 200 ? result.stderr.slice(0, 200) + "..." : result.stderr;
        this.log.debug(`[workspace] ${sid}: stderr: ${stderrPreview}`);
      }

      // Diff filesystem
      const postFiles = await walkDir(workspace.dir);
      const postSnapshot = buildSnapshot(postFiles);

      const { changedFiles, deletedFiles } = await snapshotDiff(
        workspace.dir,
        workspace.snapshot,
        postSnapshot,
        this.log,
        `[workspace] ${sid}: `,
      );

      // Update snapshot for next command
      workspace.snapshot = postSnapshot;

      if (changedFiles.length > 0 || deletedFiles.length > 0) {
        this.log.info(`[workspace] ${sid}: ${changedFiles.length} changed/new file(s), ${deletedFiles.length} deleted file(s)`);
        for (const f of changedFiles) {
          this.log.debug(`[workspace] ${sid}:   changed: ${f.path} (${f.sizeBytes} bytes)`);
        }
        for (const f of deletedFiles) {
          this.log.debug(`[workspace] ${sid}:   deleted: ${f}`);
        }
      } else {
        this.log.debug(`[workspace] ${sid}: no filesystem changes detected`);
      }

      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        ...(changedFiles.length > 0 ? { changedFiles } : {}),
        ...(deletedFiles.length > 0 ? { deletedFiles } : {}),
      };
    });
  }

  getWorkspaceDir(workspaceId: string): string | null {
    return this.workspaces.get(workspaceId)?.dir ?? null;
  }

  async destroyWorkspace(workspaceId: string): Promise<void> {
    const state = this.workspaces.get(workspaceId);
    if (!state) return;

    const sid = shortId(workspaceId);

    await this.backend.destroyWorkspace(workspaceId);
    this.workspaces.delete(workspaceId);
    this.locks.delete(workspaceId);

    // Remove workspace directory
    await fs.rm(state.dir, { recursive: true, force: true }).catch(() => {});
    this.log.info(`[workspace] Destroyed workspace ${sid}`);
  }

  async destroyAll(): Promise<void> {
    const ids = [...this.workspaces.keys()];
    if (ids.length > 0) {
      this.log.info(`[workspace] Destroying all ${ids.length} workspace(s)`);
    }
    await Promise.all(ids.map((id) => this.destroyWorkspace(id)));
  }

  stop(): void {
    clearInterval(this.reaper);
    this.destroyAll();
  }
}
