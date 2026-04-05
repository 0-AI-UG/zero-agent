/**
 * Local execution backend — runs one combined session container (workspace + browser)
 * per project using the Docker Engine API via Unix socket.
 *
 * Architecture:
 * - One container per project (no pooling, no pause/resume)
 * - No host filesystem bind mounts — all file I/O goes through Docker exec / archive API + S3
 * - Two persistence layers on container destroy:
 *   1. /workspace → individual project files in S3 (user-visible)
 *   2. Everything else → opaque system snapshot in S3 (packages, configs, etc.)
 * - Idle reaper destroys containers after configurable inactivity
 * - Browser actions serialized per-project via lock
 */
import * as path from "node:path";
import type { BrowserAction, BrowserResult } from "@/lib/browser/protocol.ts";
import { CdpClient, connectToPage } from "./cdp.ts";
import { executeAction, type RefMap, type CursorState, type SnapshotCache } from "./browser-actions.ts";
import { readBinaryFromS3, writeToS3 } from "@/lib/s3.ts";
import { log } from "@/lib/logger.ts";
import { getSetting } from "@/lib/settings.ts";
import { docker } from "@/lib/docker-client.ts";
import { fetchWithTimeout } from "@/lib/deferred.ts";
import {
  touchMarker, listWorkspaceFiles, detectChanges, readFiles,
  writeFiles, deleteFiles, saveSystemSnapshot, restoreSystemSnapshot,
} from "./container-fs.ts";

const backendLog = log.child({ module: "local-backend" });

const SESSION_IMAGE = "zero-session:latest";
const CDP_PORT = 9223;

const DESTROY_TIMEOUT_MS = Number(process.env.CONTAINER_DESTROY_TIMEOUT_SECS ?? 600) * 1000;
const REAPER_INTERVAL_MS = 30_000;
const BACKUP_INTERVAL_MS = 5 * 60_000;

function networkForProject(projectId: string): string {
  return `zero-net-${projectId}`;
}

const MAX_OUTPUT = 1_048_576; // 1 MB

const IS_PROD = process.env.NODE_ENV === "production";
const PROJECT_ROOT = IS_PROD ? "/app" : path.resolve(import.meta.dir, "../../..");
const SESSION_DOCKERFILE_DIR = path.join(PROJECT_ROOT, "docker/session");

// ── Session state ──

interface SessionState {
  projectId: string;
  userId: string;
  containerId: string;
  containerIp: string;
  cdp: CdpClient | null;
  refMap: RefMap;
  cursor: CursorState;
  snapshotCache: SnapshotCache;
  lastFileList: Set<string>;              // workspace file list for change detection
  lastManifest: Record<string, string>;
  lock: Promise<void>;
  cdpReconnectAttempts: number;
  lastUsedAt: number;
  busyCount: number;
}

export interface BashResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  changedFiles?: Array<{ path: string; data: string; sizeBytes: number }>;
  deletedFiles?: string[];
}

const DOWNLOAD_CONCURRENCY = 10;

export class LocalBackend {
  private sessions = new Map<string, SessionState>();
  private destroying = new Set<string>();
  private creationLocks = new Map<string, Promise<void>>();
  private imageReady = false;
  private imageBuilding: Promise<void> | null = null;
  private readyNetworks = new Set<string>();
  private _dockerReady = false;
  private reaperInterval: ReturnType<typeof setInterval> | null = null;
  private lastBackup = new Map<string, number>();

  /** Wait for the Docker daemon to be ready, build the image, start reaper. */
  async waitForDocker(maxWaitMs = 30_000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      if (await docker.info()) {
        this._dockerReady = true;
        backendLog.info("Docker daemon is ready");
        await this.cleanupOrphanedContainers();
        await this.ensureImage();
        this.startReaper();
        return true;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    backendLog.warn("Docker daemon not available after timeout");
    return false;
  }

  isReady(): boolean {
    return this._dockerReady;
  }

  // ── Container lifecycle ──

  /**
   * Ensure a running container exists for this project.
   * Creates one if needed (restoring from S3), reuses existing.
   */
  async ensureContainer(userId: string, projectId: string): Promise<void> {
    const existing = this.sessions.get(projectId);
    if (existing) {
      existing.lastUsedAt = Date.now();
      return;
    }

    // Enforce max running containers limit
    const maxRunning = parseInt(getSetting("CONTAINER_MAX_RUNNING") ?? "3", 10);
    if (this.sessions.size >= maxRunning) {
      throw new Error("Container limit reached. Destroy an idle container or wait for one to be cleaned up.");
    }

    // Deduplicate concurrent creation for same project
    const inflight = this.creationLocks.get(projectId);
    if (inflight) {
      await inflight;
      return;
    }

    let resolve: () => void;
    const lock = new Promise<void>((r) => { resolve = r; });
    this.creationLocks.set(projectId, lock);

    try {
      await this.createContainer(userId, projectId);
    } finally {
      this.creationLocks.delete(projectId);
      resolve!();
    }
  }

  private async createContainer(userId: string, projectId: string): Promise<void> {
    const startTime = Date.now();
    backendLog.info("createContainer start", { userId, projectId });

    await this.ensureImage();
    const network = networkForProject(projectId);
    await this.ensureNetwork(network);

    const containerName = `session-${projectId}`;

    try {
      // Remove stale container if exists
      await docker.removeContainer(containerName).catch(() => {});

      backendLog.info("createContainer starting", { projectId, containerName });
      const containerId = await docker.createAndStartContainer({
        name: containerName,
        image: SESSION_IMAGE,
        network,
        // No bind mounts — files synced via Docker API + S3
        memory: 1024 * 1024 * 1024,
        cpus: 2,
        pidsLimit: 512,
      });

      const containerIp = await docker.getContainerIp(containerName);
      if (!containerIp) throw new Error("Could not determine container IP");

      // Restore system snapshot (installed packages, configs) if available
      await this.restoreSystemState(projectId, containerName);

      backendLog.info("createContainer waiting for CDP", { projectId, containerIp });
      await this.waitForCdp(containerIp, CDP_PORT);

      const { cdp } = await connectToPage(containerIp, CDP_PORT);
      const snapshotCache: SnapshotCache = { dirty: true, lastContent: "" };

      const session: SessionState = {
        projectId,
        userId,
        containerId,
        containerIp,
        cdp,
        refMap: new Map(),
        cursor: { x: 0, y: 0 },
        snapshotCache,
        lastFileList: new Set(),
        lastManifest: {},
        lock: Promise.resolve(),
        cdpReconnectAttempts: 0,
        lastUsedAt: Date.now(),
        busyCount: 0,
      };

      this.registerDomListener(cdp, snapshotCache);
      cdp.onClose = () => { session.cdp = null; };
      this.sessions.set(projectId, session);

      backendLog.info("createContainer complete", { projectId, containerId: containerId.slice(0, 12), containerIp, totalMs: Date.now() - startTime });

      // Restart pinned ports for this project
      this.restartPinnedPorts(projectId, containerName, containerIp);
    } catch (err) {
      backendLog.error("createContainer failed, cleaning up", { projectId, error: String(err) });
      await docker.removeContainer(containerName).catch(() => {});
      throw err;
    }
  }

  private async restoreSystemState(projectId: string, containerName: string): Promise<void> {
    const s3Key = `containers/${projectId}/system.tar.gz`;
    try {
      const buffer = await readBinaryFromS3(s3Key);
      if (buffer && buffer.byteLength > 0) {
        await restoreSystemSnapshot(containerName, buffer);
        backendLog.info("system state restored from S3", { projectId, sizeBytes: buffer.byteLength });
      }
    } catch {
      // No system snapshot available — fresh container
    }
  }

  private restartPinnedPorts(projectId: string, containerName: string, containerIp: string): void {
    import("./lifecycle.ts").then(({ getPortManager }) => {
      const pm = getPortManager();
      if (pm) {
        pm.restartPinnedForProject(projectId, containerName, containerIp).catch((err) =>
          backendLog.warn("failed to restart pinned ports", { projectId, error: String(err) })
        );
      }
    }).catch(() => {});
  }

  /** Sync project files from S3 into the container workspace. */
  async syncProjectFiles(projectId: string, manifest: Record<string, string>): Promise<void> {
    const session = this.sessions.get(projectId);
    if (!session) return;

    const containerName = `session-${projectId}`;

    // Only download files that are new or changed since last sync
    const changedEntries = Object.entries(manifest).filter(
      ([relativePath, url]) => session.lastManifest[relativePath] !== url,
    );

    // Delete files removed from manifest
    const removedPaths = Object.keys(session.lastManifest).filter((p) => !(p in manifest));
    if (removedPaths.length > 0) {
      await deleteFiles(containerName, removedPaths);
    }

    // Download changed files from S3 and write into container
    if (changedEntries.length > 0) {
      const filesToWrite: Array<{ relativePath: string; data: Buffer }> = [];

      for (let i = 0; i < changedEntries.length; i += DOWNLOAD_CONCURRENCY) {
        const batch = changedEntries.slice(i, i + DOWNLOAD_CONCURRENCY);
        const results = await Promise.all(batch.map(async ([relativePath]) => {
          const s3Key = `projects/${projectId}/${relativePath}`;
          const buffer = await readBinaryFromS3(s3Key);
          return { relativePath, data: buffer };
        }));
        filesToWrite.push(...results);
      }

      await writeFiles(containerName, filesToWrite);
    }

    // Update file list for change detection and store manifest
    session.lastFileList = await listWorkspaceFiles(containerName);
    session.lastManifest = { ...manifest };

    backendLog.info("project files synced", { projectId, changed: changedEntries.length, removed: removedPaths.length, total: Object.keys(manifest).length });
  }

  /**
   * Destroy a project's container.
   * Saves workspace files to project S3 and system snapshot separately.
   */
  async destroyContainer(projectId: string): Promise<void> {
    if (this.destroying.has(projectId)) return;
    this.destroying.add(projectId);

    try {
      const session = this.sessions.get(projectId);
      this.sessions.delete(projectId);
      this.latestScreenshots.delete(projectId);
      this.lastBackup.delete(projectId);

      // Mark ports as stopped
      try {
        const { getPortManager } = await import("./lifecycle.ts");
        const pm = getPortManager();
        if (pm) pm.markProjectPortsStopped(projectId);
      } catch {}

      if (!session) return;

      const containerName = `session-${projectId}`;

      // Save system snapshot (everything outside /workspace) to S3
      const systemBuffer = await saveSystemSnapshot(containerName).catch(() => null);
      if (systemBuffer) {
        await writeToS3(`containers/${projectId}/system.tar.gz`, systemBuffer).catch((err) => {
          backendLog.warn("failed to save system snapshot to S3", { projectId, error: String(err) });
        });
      }

      try { session.cdp?.close(); } catch {}
      try { await docker.removeContainer(containerName); } catch (err) {
        backendLog.warn("failed to remove container", { projectId, error: String(err) });
      }

      backendLog.info("container destroyed", { projectId });
    } finally {
      this.destroying.delete(projectId);
    }
  }

  touchActivity(projectId: string): void {
    const session = this.sessions.get(projectId);
    if (session) session.lastUsedAt = Date.now();
  }

  // ── Browser execution ──

  private latestScreenshots = new Map<string, { base64: string; title: string; url: string; timestamp: number }>();

  async execute(userId: string, projectId: string, action: BrowserAction, stealth?: boolean): Promise<BrowserResult> {
    const startTime = Date.now();
    await this.ensureContainer(userId, projectId);

    const session = this.sessions.get(projectId);
    if (!session) throw new Error("No browser session found");

    session.busyCount++;
    session.lastUsedAt = Date.now();

    try {
      return await this.withLock(projectId, async () => {
        // Auto-reconnect CDP if disconnected
        if (!session.cdp || !session.cdp.connected) {
          if (session.cdpReconnectAttempts >= 3) {
            throw new Error("Browser crashed and could not be reconnected.");
          }
          session.cdpReconnectAttempts++;
          backendLog.info("CDP disconnected, reconnecting", { projectId, attempt: session.cdpReconnectAttempts });
          await this.waitForCdp(session.containerIp, CDP_PORT, 5000);
          const { cdp: newCdp } = await connectToPage(session.containerIp, CDP_PORT);
          session.cdp = newCdp;
          newCdp.onClose = () => { session.cdp = null; };
          session.cdpReconnectAttempts = 0;
          session.snapshotCache.dirty = true;
          this.registerDomListener(newCdp, session.snapshotCache);
        }

        const result = await executeAction(session.cdp, action, session.containerIp, CDP_PORT, session.refMap, {
          stealth, cursor: session.cursor, snapshotCache: session.snapshotCache,
        });

        // Auto-capture screenshot for live preview (fire-and-forget)
        if (action.type !== "screenshot" && session.cdp) {
          session.cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 50 }).then((capture) => {
            const info = result.type === "done" || result.type === "snapshot" || result.type === "screenshot"
              ? { title: (result as any).title ?? "", url: (result as any).url ?? "" }
              : { title: "", url: "" };
            this.latestScreenshots.set(projectId, { base64: capture.data, title: info.title, url: info.url, timestamp: Date.now() });
          }).catch(() => {});
        } else if (action.type === "screenshot" && result.type === "screenshot") {
          this.latestScreenshots.set(projectId, { base64: result.base64, title: result.title, url: result.url, timestamp: Date.now() });
        }

        return result;
      });
    } finally {
      session.busyCount--;
    }
  }

  getLatestScreenshot(projectId: string): { base64: string; title: string; url: string; timestamp: number } | null {
    return this.latestScreenshots.get(projectId) ?? null;
  }

  // ── Code execution ──

  async runBash(userId: string, projectId: string, command: string, timeout?: number, background?: boolean): Promise<BashResult> {
    await this.ensureContainer(userId, projectId);

    const session = this.sessions.get(projectId);
    if (!session) throw new Error("Execution environment not found");

    session.busyCount++;
    session.lastUsedAt = Date.now();
    const containerName = `session-${projectId}`;

    try {
      // Background mode: run with nohup and return immediately
      if (background) {
        const bgCommand = `nohup bash -c '${command.replace(/'/g, "'\\''")}' > /dev/null 2>&1 & echo $!`;
        const execResult = await docker.exec(containerName, ["bash", "-c", bgCommand], { timeout: 15_000 });
        const pid = execResult.stdout.trim();
        return {
          stdout: pid ? `Process started in background (PID: ${pid})` : execResult.stdout,
          stderr: execResult.stderr,
          exitCode: execResult.exitCode,
        };
      }

      // Touch marker before execution for change detection
      await touchMarker(containerName);

      const effectiveTimeout = timeout ?? 120_000;

      let execResult: Awaited<ReturnType<typeof docker.exec>>;
      try {
        execResult = await docker.exec(containerName, ["bash", "-c", command], { timeout: effectiveTimeout });
      } catch (err) {
        const errMsg = String(err);
        if (errMsg.includes("OCI runtime") || errMsg.includes("container breakout")) {
          backendLog.error("exec OCI error, destroying broken session", { projectId, error: errMsg });
          this.sessions.delete(projectId);
          await docker.removeContainer(containerName).catch(() => {});
        }
        throw err;
      }

      const stdout = execResult.stdout.length > MAX_OUTPUT
        ? execResult.stdout.slice(0, MAX_OUTPUT) + "\n[output truncated at 1MB]"
        : execResult.stdout;
      const stderr = execResult.stderr.length > MAX_OUTPUT
        ? execResult.stderr.slice(0, MAX_OUTPUT) + "\n[output truncated at 1MB]"
        : execResult.stderr;

      // Strip workspace paths from output
      const cleanStdout = stdout.replaceAll("/workspace/", "").replaceAll("/workspace", ".");
      const cleanStderr = stderr.replaceAll("/workspace/", "").replaceAll("/workspace", ".");

      // Detect changes inside container
      const { changed, deleted } = await detectChanges(containerName, session.lastFileList);

      // Read changed file contents from container
      const changedFiles = changed.length > 0
        ? await readFiles(containerName, changed)
        : [];

      // Update file list for next detection
      session.lastFileList = await listWorkspaceFiles(containerName);

      return {
        stdout: cleanStdout,
        stderr: cleanStderr,
        exitCode: execResult.exitCode,
        ...(changedFiles.length > 0 ? { changedFiles } : {}),
        ...(deleted.length > 0 ? { deletedFiles: deleted } : {}),
      };
    } finally {
      session.busyCount--;
    }
  }

  // ── Helpers ──

  private registerDomListener(cdp: CdpClient, cache: SnapshotCache): void {
    cdp.send("DOM.enable").catch(() => {});
    cdp.on("DOM.documentUpdated", () => { cache.dirty = true; });
    cdp.on("DOM.childNodeInserted", () => { cache.dirty = true; });
    cdp.on("DOM.childNodeRemoved", () => { cache.dirty = true; });
    cdp.on("DOM.attributeModified", () => { cache.dirty = true; });
  }

  private async withLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const session = this.sessions.get(projectId);
    if (!session) throw new Error("Session not found");
    const prev = session.lock;
    let resolve: () => void;
    session.lock = new Promise<void>((r) => { resolve = r; });
    await prev;
    try { return await fn(); }
    finally { resolve!(); }
  }

  /** Find session info for a project. Used by PortManager. */
  getSessionForProject(projectId: string): { sessionId: string; containerIp: string; containerName: string } | null {
    const session = this.sessions.get(projectId);
    if (!session) return null;
    return {
      sessionId: projectId,
      containerIp: session.containerIp,
      containerName: `session-${projectId}`,
    };
  }

  /** Ensure a running session exists for a project (used by PortManager cold-start). */
  async ensureSessionForProject(projectId: string, userId: string): Promise<{ sessionId: string; containerIp: string; containerName: string }> {
    await this.ensureContainer(userId, projectId);
    const session = this.sessions.get(projectId);
    if (!session) throw new Error("Failed to create session");
    return {
      sessionId: projectId,
      containerIp: session.containerIp,
      containerName: `session-${projectId}`,
    };
  }

  /** List all tracked containers. */
  listContainers(): Array<{ sessionId: string; userId: string; projectId: string; status: string; lastUsedAt: number }> {
    return [...this.sessions.values()].map((s) => ({
      sessionId: s.projectId,
      userId: s.userId,
      projectId: s.projectId,
      status: "running" as string,
      lastUsedAt: s.lastUsedAt,
    }));
  }

  private async cleanupOrphanedContainers(): Promise<void> {
    try {
      const containers = await docker.listContainers({ all: true });
      const orphaned = containers.filter((c) =>
        c.Names.some((n) => /^\/(session-)/.test(n)),
      );
      if (orphaned.length === 0) return;

      backendLog.info("cleaning up orphaned containers", { count: orphaned.length });
      await Promise.allSettled(
        orphaned.map(async (c) => {
          const name = c.Names[0]?.replace(/^\//, "") ?? c.Id;
          await docker.removeContainer(name).catch(() => {});
        }),
      );
    } catch (err) {
      backendLog.warn("failed to cleanup orphaned containers", { error: String(err) });
    }
  }

  private async ensureNetwork(name: string): Promise<void> {
    if (this.readyNetworks.has(name)) return;
    await docker.ensureNetwork(name);
    this.readyNetworks.add(name);
  }

  private async ensureImage(): Promise<void> {
    if (this.imageReady) return;
    if (this.imageBuilding) return this.imageBuilding;

    this.imageBuilding = (async () => {
      if (await docker.imageExists(SESSION_IMAGE)) {
        this.imageReady = true;
        return;
      }

      const registryImage = process.env.SESSION_REGISTRY_IMAGE;
      if (registryImage) {
        try {
          backendLog.info("pulling session image from registry", { image: registryImage });
          await docker.pullImage(registryImage);
          await docker.tagImage(registryImage, SESSION_IMAGE);
          this.imageReady = true;
          return;
        } catch (err) {
          backendLog.warn("failed to pull session image, building locally", { error: String(err) });
        }
      }

      backendLog.info("building session image", { dir: SESSION_DOCKERFILE_DIR });
      await docker.buildImage(SESSION_IMAGE, SESSION_DOCKERFILE_DIR);
      this.imageReady = true;
      backendLog.info("session image built");
    })();

    return this.imageBuilding;
  }

  private async waitForCdp(host: string, port: number, maxWaitMs = 15_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      try {
        const res = await fetchWithTimeout(`http://${host}:${port}/json/version`, { timeout: 2000 });
        if (res.ok) return;
      } catch {}
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("Chrome CDP not ready within timeout");
  }

  // ── Idle reaper ──

  private startReaper(): void {
    this.reaperInterval = setInterval(() => this.reap(), REAPER_INTERVAL_MS);
  }

  private async reap(): Promise<void> {
    const now = Date.now();
    for (const [projectId, session] of this.sessions) {
      if (session.busyCount > 0) continue;
      if (now - session.lastUsedAt > DESTROY_TIMEOUT_MS) {
        backendLog.info("reaper destroying idle container", { projectId, idleMs: now - session.lastUsedAt });
        await this.destroyContainer(projectId).catch((err) =>
          backendLog.warn("reaper destroy failed", { projectId, error: String(err) })
        );
        continue;
      }

      // Periodic backup of active containers
      const lastBackupAt = this.lastBackup.get(projectId) ?? 0;
      if (now - lastBackupAt > BACKUP_INTERVAL_MS) {
        this.lastBackup.set(projectId, now);
        this.backupContainer(projectId, session.containerName).catch((err) =>
          backendLog.warn("periodic backup failed", { projectId, error: String(err) })
        );
      }
    }
  }

  private async backupContainer(projectId: string, containerName: string): Promise<void> {
    const systemBuffer = await saveSystemSnapshot(containerName).catch(() => null);
    if (systemBuffer) {
      await writeToS3(`containers/${projectId}/system.tar.gz`, systemBuffer);
      backendLog.info("periodic backup saved", { projectId });
    }
  }

  /** Clean up all sessions on shutdown. Save snapshots first. */
  async destroyAll(): Promise<void> {
    if (this.reaperInterval) {
      clearInterval(this.reaperInterval);
      this.reaperInterval = null;
    }
    const ids = [...this.sessions.keys()];
    await Promise.allSettled(ids.map((id) => this.destroyContainer(id)));
  }
}
