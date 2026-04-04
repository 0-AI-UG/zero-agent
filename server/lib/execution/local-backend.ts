/**
 * Local execution backend — runs combined session containers (workspace + browser)
 * inside the server's own Docker daemon (DinD).
 */
import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { ExecutionBackend, BashResult } from "./types.ts";
import type { BrowserAction, BrowserResult, CompanionStatus } from "@/lib/browser/protocol.ts";
import { CdpClient, connectToPage } from "./cdp.ts";
import { executeAction, type RefMap, type CursorState, type SnapshotCache } from "./browser-actions.ts";
import { ResourceManager } from "./resource-manager.ts";
import { readBinaryFromS3 } from "@/lib/s3.ts";
import { log } from "@/lib/logger.ts";

const backendLog = log.child({ module: "local-backend" });

const SESSION_IMAGE = "zero-session:latest";
const NETWORK_NAME = "zero-agent-net";
const CDP_PORT = 9223;
const NOVNC_PORT = 6080;
const MAX_OUTPUT = 1_048_576; // 1 MB

// Resolve paths relative to the project root (works in both dev and prod)
const IS_PROD = process.env.NODE_ENV === "production";
const PROJECT_ROOT = IS_PROD ? "/app" : path.resolve(import.meta.dir, "../../..");
const SESSION_DOCKERFILE_DIR = path.join(PROJECT_ROOT, "docker/session");
const WORKSPACE_ROOT = path.join(PROJECT_ROOT, "data/workspaces");

/** Directories that should never be included in snapshots or synced back. */
const IGNORED_DIRS = new Set([".venv", "node_modules", ".tmp", "__pycache__", ".git"]);

// ── Snapshot utilities (ported from companion/src/workspace-utils.ts) ──

interface FileEntry {
  path: string;
  mtimeMs: number;
  size: number;
}

type Snapshot = Map<string, { mtimeMs: number; size: number }>;

async function walkDir(dir: string, base: string = dir): Promise<FileEntry[]> {
  const results: FileEntry[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const stat = await fs.lstat(fullPath);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        results.push(...await walkDir(fullPath, base));
      } else if (stat.isFile()) {
        results.push({ path: path.relative(base, fullPath), mtimeMs: stat.mtimeMs, size: stat.size });
      }
    }
  } catch {
    // Directory doesn't exist yet
  }
  return results;
}

function buildSnapshot(files: FileEntry[]): Snapshot {
  const snapshot: Snapshot = new Map();
  for (const file of files) {
    snapshot.set(file.path, { mtimeMs: file.mtimeMs, size: file.size });
  }
  return snapshot;
}

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;

async function snapshotDiff(
  workspaceDir: string,
  pre: Snapshot,
  post: Snapshot,
): Promise<{ changedFiles: Array<{ path: string; data: string; sizeBytes: number }>; deletedFiles: string[] }> {
  const resolvedBase = path.resolve(workspaceDir) + path.sep;
  const changedFiles: Array<{ path: string; data: string; sizeBytes: number }> = [];
  let totalBytes = 0;

  for (const [filePath, postEntry] of post) {
    const preEntry = pre.get(filePath);
    if (!preEntry || preEntry.mtimeMs !== postEntry.mtimeMs || preEntry.size !== postEntry.size) {
      if (postEntry.size > MAX_FILE_BYTES) continue;
      if (totalBytes + postEntry.size > MAX_TOTAL_BYTES) continue;
      const fullPath = path.resolve(workspaceDir, filePath);
      if (!fullPath.startsWith(resolvedBase)) continue;
      const file = Bun.file(fullPath);
      const buffer = Buffer.from(await file.arrayBuffer());
      totalBytes += postEntry.size;
      changedFiles.push({ path: filePath, data: buffer.toString("base64"), sizeBytes: postEntry.size });
    }
  }

  const deletedFiles: string[] = [];
  for (const filePath of pre.keys()) {
    if (!post.has(filePath)) deletedFiles.push(filePath);
  }

  return { changedFiles, deletedFiles };
}

async function readCapped(stream: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (totalBytes + value.byteLength > maxBytes) {
        const remaining = maxBytes - totalBytes;
        if (remaining > 0) chunks.push(value.subarray(0, remaining));
        totalBytes = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(value);
      totalBytes += value.byteLength;
    }
  } finally {
    if (truncated) await reader.cancel();
    reader.releaseLock();
  }

  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(merged);
  return truncated ? text + "\n[output truncated at 1MB]" : text;
}

// ── Session state ──

interface SessionState {
  containerId: string;
  containerIp: string;
  cdp: CdpClient | null;
  refMap: RefMap;
  cursor: CursorState;
  snapshotCache: SnapshotCache;
  snapshot: Snapshot;
  lastManifest: Record<string, string>;
  workspaceDir: string;
  lock: Promise<void>;
  cdpReconnectAttempts: number;
}

const DOWNLOAD_CONCURRENCY = 10;

export class LocalBackend implements ExecutionBackend {
  private sessions = new Map<string, SessionState>();
  private resourceManager = new ResourceManager();
  private imageReady = false;
  private imageBuilding: Promise<void> | null = null;
  private networkReady = false;
  private _dockerReady = false;

  constructor() {
    // Wire up resource manager callbacks for pause/resume/destroy
    this.resourceManager.onPause = async (sessionId) => {
      const session = this.sessions.get(sessionId);
      if (!session) return;
      session.cdp?.close();
      session.cdp = null;
      Bun.spawnSync(["docker", "pause", `session-${sessionId}`], { stdout: "ignore", stderr: "ignore" });
      backendLog.info("session paused", { sessionId });
    };

    this.resourceManager.onResume = async (sessionId) => {
      const session = this.sessions.get(sessionId);
      if (!session) return;
      Bun.spawnSync(["docker", "unpause", `session-${sessionId}`], { stdout: "ignore", stderr: "ignore" });
      // Reconnect CDP after unpause
      await this.waitForCdp(session.containerIp, CDP_PORT);
      const { cdp } = await connectToPage(session.containerIp, CDP_PORT);
      session.cdp = cdp;
      cdp.onClose = () => { session.cdp = null; };
      session.cdpReconnectAttempts = 0;
      session.snapshotCache.dirty = true; // Force rebuild after resume
      this.registerDomListener(cdp, session.snapshotCache);
      backendLog.info("session resumed", { sessionId });
    };

    this.resourceManager.onDestroy = async (sessionId) => {
      const session = this.sessions.get(sessionId);
      if (!session) return;
      session.cdp?.close();
      Bun.spawnSync(["docker", "rm", "-f", `session-${sessionId}`], { stdout: "ignore", stderr: "ignore" });
      await fs.rm(session.workspaceDir, { recursive: true, force: true }).catch(() => {});
      this.sessions.delete(sessionId);
      backendLog.info("session destroyed by reaper", { sessionId });
    };
  }

  /** Wait for the internal Docker daemon to be ready. */
  async waitForDocker(maxWaitMs = 30_000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      const proc = Bun.spawnSync(["docker", "info"], { stdout: "pipe", stderr: "pipe" });
      if (proc.exitCode === 0) {
        this._dockerReady = true;
        backendLog.info("Docker daemon is ready");
        await fs.mkdir(WORKSPACE_ROOT, { recursive: true });
        await this.ensureNetwork();
        // Pre-build session image so first user doesn't pay build cost
        this.ensureImage().catch((err) => backendLog.error("failed to pre-build session image", err));
        return true;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    backendLog.warn("Docker daemon not available after timeout");
    return false;
  }

  private async ensureNetwork(): Promise<void> {
    if (this.networkReady) return;
    const check = Bun.spawnSync(["docker", "network", "inspect", NETWORK_NAME], { stdout: "pipe", stderr: "pipe" });
    if (check.exitCode !== 0) {
      const create = Bun.spawnSync(["docker", "network", "create", NETWORK_NAME], { stdout: "pipe", stderr: "pipe" });
      if (create.exitCode !== 0) {
        backendLog.warn("failed to create Docker network", { network: NETWORK_NAME });
        return;
      }
      backendLog.info("created Docker network", { network: NETWORK_NAME });
    }
    this.networkReady = true;
  }

  private async ensureImage(): Promise<void> {
    if (this.imageReady) return;
    if (this.imageBuilding) return this.imageBuilding;

    this.imageBuilding = (async () => {
      const check = Bun.spawnSync(["docker", "image", "inspect", SESSION_IMAGE], { stdout: "pipe", stderr: "pipe" });
      if (check.exitCode === 0) {
        this.imageReady = true;
        return;
      }

      backendLog.info("building session image", { dir: SESSION_DOCKERFILE_DIR });
      const sessionDir = SESSION_DOCKERFILE_DIR;
      const proc = Bun.spawn(["docker", "build", "-t", SESSION_IMAGE, sessionDir], { stdout: "pipe", stderr: "pipe" });
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        throw new Error(`Failed to build session image: ${stderr}`);
      }
      this.imageReady = true;
      backendLog.info("session image built");
    })();

    return this.imageBuilding;
  }

  private async withLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Session not found");
    const prev = session.lock;
    let resolve: () => void;
    session.lock = new Promise<void>((r) => { resolve = r; });
    await prev;
    try { return await fn(); }
    finally { resolve!(); }
  }

  // ── ExecutionBackend interface ──

  isAvailable(_userId: string, _projectId: string): boolean {
    return this._dockerReady;
  }

  getStatus(_userId: string, _projectId: string): CompanionStatus {
    return {
      connected: this._dockerReady,
      dockerInstalled: true,
      dockerRunning: this._dockerReady,
      chromeAvailable: true,
    };
  }

  async createSession(userId: string, projectId: string, sessionId: string, _label?: string): Promise<void> {
    const startTime = Date.now();
    backendLog.info("createSession start", { userId, projectId, sessionId, label: _label });

    if (this.sessions.has(sessionId)) {
      backendLog.info("createSession reusing existing session", { sessionId });
      await this.resourceManager.ensureRunning(sessionId);
      return;
    }

    const check = this.resourceManager.canCreate();
    if (!check.allowed) {
      backendLog.warn("createSession denied by resource manager", { sessionId, reason: check.reason });
      throw new Error(check.reason!);
    }

    // Pause an existing container if we're at the running limit
    backendLog.info("createSession ensuring slot", { sessionId });
    await this.resourceManager.ensureSlot();

    backendLog.info("createSession ensuring image", { sessionId });
    await this.ensureImage();
    await this.ensureNetwork();

    const workspaceDir = path.join(WORKSPACE_ROOT, sessionId);
    await fs.mkdir(workspaceDir, { recursive: true });

    const containerName = `session-${sessionId}`;

    // Remove stale container if exists
    Bun.spawnSync(["docker", "rm", "-f", containerName], { stdout: "ignore", stderr: "ignore" });

    // Start combined container
    backendLog.info("createSession starting container", { sessionId, containerName, image: SESSION_IMAGE });
    const proc = Bun.spawn([
      "docker", "run", "-d",
      "--name", containerName,
      "--network", NETWORK_NAME,
      "-v", `${workspaceDir}:/workspace`,
      "--memory=1g", "--cpus=2", "--pids-limit=512",
      SESSION_IMAGE,
    ], { stdout: "pipe", stderr: "pipe" });

    const containerId = (await new Response(proc.stdout).text()).trim();
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      backendLog.error("createSession container start failed", { sessionId, exitCode, stderr, elapsedMs: Date.now() - startTime });
      throw new Error(`Failed to start session container: ${stderr}`);
    }
    backendLog.info("createSession container started", { sessionId, containerId: containerId.slice(0, 12), elapsedMs: Date.now() - startTime });

    // Get container IP
    const inspectProc = Bun.spawnSync([
      "docker", "inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", containerName,
    ], { stdout: "pipe", stderr: "pipe" });
    const containerIp = new TextDecoder().decode(inspectProc.stdout).trim();

    if (!containerIp) {
      backendLog.error("createSession could not determine container IP", { sessionId, containerName });
      Bun.spawn(["docker", "rm", "-f", containerName], { stdout: "ignore", stderr: "ignore" });
      throw new Error("Could not determine container IP");
    }
    backendLog.info("createSession container IP resolved", { sessionId, containerIp, elapsedMs: Date.now() - startTime });

    // Wait for CDP to be ready
    backendLog.info("createSession waiting for CDP", { sessionId, containerIp, port: CDP_PORT });
    await this.waitForCdp(containerIp, CDP_PORT);
    backendLog.info("createSession CDP ready", { sessionId, elapsedMs: Date.now() - startTime });

    // Connect to Chrome via CDP
    backendLog.info("createSession connecting to Chrome page", { sessionId, containerIp });
    const { cdp } = await connectToPage(containerIp, CDP_PORT);
    backendLog.info("createSession CDP connected", { sessionId, elapsedMs: Date.now() - startTime });

    const snapshotCache: SnapshotCache = { dirty: true, lastContent: "" };

    const session: SessionState = {
      containerId,
      containerIp,
      cdp,
      refMap: new Map(),
      cursor: { x: 0, y: 0 },
      snapshotCache,
      snapshot: new Map(),
      lastManifest: {},
      workspaceDir,
      lock: Promise.resolve(),
      cdpReconnectAttempts: 0,
    };

    // Mark snapshot cache dirty when DOM structure changes
    this.registerDomListener(cdp, snapshotCache);

    // Auto-null CDP on disconnect so execute() can detect and reconnect
    cdp.onClose = () => { session.cdp = null; };

    this.sessions.set(sessionId, session);
    this.resourceManager.register({
      sessionId,
      userId,
      projectId,
      containerId,
      containerIp,
      lastUsedAt: Date.now(),
    });

    backendLog.info("createSession complete", { sessionId, containerId: containerId.slice(0, 12), containerIp, totalMs: Date.now() - startTime });
  }

  /** Latest screenshot per session — captured after every action for live preview. */
  private latestScreenshots = new Map<string, { base64: string; title: string; url: string; timestamp: number }>();

  async execute(userId: string, projectId: string, action: BrowserAction, sessionId?: string, stealth?: boolean): Promise<BrowserResult> {
    const startTime = Date.now();
    const sid = sessionId ?? this.findSession(userId, projectId);
    backendLog.info("execute start", { userId, projectId, sessionId: sid, action: action.type, stealth: !!stealth });

    if (!sid) {
      backendLog.error("execute no session found", { userId, projectId, sessionId });
      throw new Error("No browser session found. Create a session first.");
    }

    backendLog.info("execute ensuring container running", { sessionId: sid });
    await this.resourceManager.ensureRunning(sid);

    const session = this.sessions.get(sid);
    if (!session) {
      backendLog.error("execute session not in map after ensureRunning", { sessionId: sid });
      throw new Error("Session not found");
    }

    this.resourceManager.markBusy(sid);
    try {
      // Auto-reconnect CDP if disconnected
      if (!session.cdp || !session.cdp.connected) {
        if (session.cdpReconnectAttempts >= 3) {
          backendLog.error("execute CDP reconnect attempts exhausted", { sessionId: sid });
          throw new Error("Browser crashed and could not be reconnected. Please create a new session.");
        }
        session.cdpReconnectAttempts++;
        backendLog.info("execute CDP disconnected, attempting reconnect", { sessionId: sid, attempt: session.cdpReconnectAttempts });
        try {
          await this.waitForCdp(session.containerIp, CDP_PORT, 5000);
          const { cdp: newCdp } = await connectToPage(session.containerIp, CDP_PORT);
          session.cdp = newCdp;
          newCdp.onClose = () => { session.cdp = null; };
          session.cdpReconnectAttempts = 0;
          session.snapshotCache.dirty = true;
          this.registerDomListener(newCdp, session.snapshotCache);
          backendLog.info("execute CDP reconnected", { sessionId: sid });
        } catch (err) {
          backendLog.error("execute CDP reconnect failed", { sessionId: sid, error: String(err) });
          throw new Error("Browser crashed and could not be reconnected. Please create a new session.");
        }
      }

      this.resourceManager.get(sid); // touch last-used
      backendLog.info("execute calling executeAction", { sessionId: sid, action: action.type, containerIp: session.containerIp });
      const result = await executeAction(session.cdp, action, session.containerIp, CDP_PORT, session.refMap, { stealth, cursor: session.cursor, snapshotCache: session.snapshotCache });
      backendLog.info("execute action complete", { sessionId: sid, action: action.type, resultType: result?.type, elapsedMs: Date.now() - startTime });

      // Auto-capture screenshot after every action for live preview (fire-and-forget)
      if (action.type !== "screenshot" && session.cdp) {
        session.cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 50 }).then((capture) => {
          const info = result.type === "done" || result.type === "snapshot" || result.type === "screenshot"
            ? { title: (result as any).title ?? "", url: (result as any).url ?? "" }
            : { title: "", url: "" };
          this.latestScreenshots.set(sid, { base64: capture.data, title: info.title, url: info.url, timestamp: Date.now() });
          backendLog.info("execute auto-screenshot captured", { sessionId: sid });
        }).catch((err) => {
          backendLog.warn("execute auto-screenshot failed", { sessionId: sid, error: String(err) });
        });
      } else if (action.type === "screenshot" && result.type === "screenshot") {
        this.latestScreenshots.set(sid, { base64: result.base64, title: result.title, url: result.url, timestamp: Date.now() });
      }

      return result;
    } finally {
      this.resourceManager.markIdle(sid);
    }
  }

  /** Get the latest auto-captured screenshot for a session. */
  getLatestScreenshot(sessionId: string): { base64: string; title: string; url: string; timestamp: number } | null {
    return this.latestScreenshots.get(sessionId) ?? null;
  }

  async destroySession(_userId: string, _projectId: string, sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);

    // Always clean up state maps, even if container cleanup fails
    this.sessions.delete(sessionId);
    this.latestScreenshots.delete(sessionId);
    this.resourceManager.remove(sessionId);

    if (!session) return;

    try { session.cdp?.close(); } catch (err) {
      backendLog.warn("failed to close CDP during destroy", { sessionId, error: String(err) });
    }
    try { Bun.spawn(["docker", "rm", "-f", `session-${sessionId}`], { stdout: "ignore", stderr: "ignore" }); } catch (err) {
      backendLog.warn("failed to remove container during destroy", { sessionId, error: String(err) });
    }
    await fs.rm(session.workspaceDir, { recursive: true, force: true }).catch((err) => {
      backendLog.warn("failed to remove workspace during destroy", { sessionId, error: String(err) });
    });

    backendLog.info("session destroyed", { sessionId });
  }

  async createWorkspace(userId: string, projectId: string, workspaceId: string, manifest: Record<string, string>): Promise<void> {
    // Ensure a session container exists and is running
    if (!this.sessions.has(workspaceId)) {
      await this.createSession(userId, projectId, workspaceId);
    } else {
      await this.resourceManager.ensureRunning(workspaceId);
    }

    const session = this.sessions.get(workspaceId)!;
    const dir = session.workspaceDir;
    const resolvedBase = path.resolve(dir) + path.sep;

    // Copy files from S3 directly (no HTTP — local S3 storage)
    const entries = Object.entries(manifest);
    for (let i = 0; i < entries.length; i += DOWNLOAD_CONCURRENCY) {
      const batch = entries.slice(i, i + DOWNLOAD_CONCURRENCY);
      await Promise.all(batch.map(async ([relativePath]) => {
        const filePath = path.join(dir, relativePath);
        if (!path.resolve(filePath).startsWith(resolvedBase)) return;
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        const s3Key = `projects/${projectId}/${relativePath}`;
        const buffer = await readBinaryFromS3(s3Key);
        await Bun.write(filePath, buffer);
      }));
    }

    // Take initial snapshot and store manifest for incremental sync
    const files = await walkDir(dir);
    session.snapshot = buildSnapshot(files);
    session.lastManifest = { ...manifest };

    backendLog.info("workspace created", { workspaceId, fileCount: entries.length });
  }

  async syncWorkspace(userId: string, projectId: string, workspaceId: string, manifest: Record<string, string>): Promise<void> {
    const session = this.sessions.get(workspaceId);
    if (!session) throw new Error("Execution environment not found — it may have been cleaned up. Please retry.");

    const dir = session.workspaceDir;
    const resolvedBase = path.resolve(dir) + path.sep;

    // Only download files that are new or changed since last sync
    const changedEntries = Object.entries(manifest).filter(
      ([relativePath, url]) => session.lastManifest[relativePath] !== url,
    );

    // Delete files removed from manifest
    const removedPaths = Object.keys(session.lastManifest).filter((p) => !(p in manifest));
    for (const relativePath of removedPaths) {
      const filePath = path.join(dir, relativePath);
      if (path.resolve(filePath).startsWith(resolvedBase)) {
        await fs.rm(filePath, { force: true }).catch(() => {});
      }
    }

    if (changedEntries.length > 0) {
      for (let i = 0; i < changedEntries.length; i += DOWNLOAD_CONCURRENCY) {
        const batch = changedEntries.slice(i, i + DOWNLOAD_CONCURRENCY);
        await Promise.all(batch.map(async ([relativePath]) => {
          const filePath = path.join(dir, relativePath);
          if (!path.resolve(filePath).startsWith(resolvedBase)) return;
          await fs.mkdir(path.dirname(filePath), { recursive: true });
          const s3Key = `projects/${projectId}/${relativePath}`;
          const buffer = await readBinaryFromS3(s3Key);
          await Bun.write(filePath, buffer);
        }));
      }

      // Only re-scan filesystem if files actually changed
      const files = await walkDir(dir);
      session.snapshot = buildSnapshot(files);
    }

    session.lastManifest = { ...manifest };
    backendLog.info("workspace synced", { workspaceId, changed: changedEntries.length, removed: removedPaths.length, total: Object.keys(manifest).length });
  }

  async runBash(_userId: string, _projectId: string, workspaceId: string, command: string, timeout?: number): Promise<BashResult> {
    await this.resourceManager.ensureRunning(workspaceId);

    this.resourceManager.markBusy(workspaceId);
    try {
      return this.withLock(workspaceId, async () => {
      const session = this.sessions.get(workspaceId);
      if (!session) throw new Error("Execution environment not found — it may have been cleaned up. Please retry.");

      this.resourceManager.get(workspaceId); // touch last-used

      const effectiveTimeout = timeout ?? 120_000;
      const containerName = `session-${workspaceId}`;

      const proc = Bun.spawn(
        ["docker", "exec", containerName, "bash", "-c", command],
        { stdout: "pipe", stderr: "pipe" },
      );

      const timer = setTimeout(() => proc.kill(), effectiveTimeout);
      const [stdout, stderr] = await Promise.all([
        readCapped(proc.stdout, MAX_OUTPUT),
        readCapped(proc.stderr, MAX_OUTPUT),
      ]);
      clearTimeout(timer);
      const exitCode = await proc.exited;

      // Strip workspace paths
      const wsPrefix = session.workspaceDir.endsWith("/") ? session.workspaceDir : session.workspaceDir + "/";
      const cleanStdout = stdout.replaceAll(wsPrefix, "").replaceAll(session.workspaceDir, ".");
      const cleanStderr = stderr.replaceAll(wsPrefix, "").replaceAll(session.workspaceDir, ".");

      // Diff filesystem
      const postFiles = await walkDir(session.workspaceDir);
      const postSnapshot = buildSnapshot(postFiles);
      const { changedFiles, deletedFiles } = await snapshotDiff(session.workspaceDir, session.snapshot, postSnapshot);
      session.snapshot = postSnapshot;

      return {
        stdout: cleanStdout,
        stderr: cleanStderr,
        exitCode,
        ...(changedFiles.length > 0 ? { changedFiles } : {}),
        ...(deletedFiles.length > 0 ? { deletedFiles } : {}),
      };
    });
    } finally {
      this.resourceManager.markIdle(workspaceId);
    }
  }

  async destroyWorkspace(userId: string, projectId: string, workspaceId: string): Promise<void> {
    return this.destroySession(userId, projectId, workspaceId);
  }

  // ── Helpers ──

  /** Register CDP event listener to mark snapshot cache dirty on DOM changes. */
  private registerDomListener(cdp: CdpClient, cache: SnapshotCache): void {
    cdp.send("DOM.enable").catch(() => {});
    cdp.on("DOM.documentUpdated", () => { cache.dirty = true; });
    cdp.on("DOM.childNodeInserted", () => { cache.dirty = true; });
    cdp.on("DOM.childNodeRemoved", () => { cache.dirty = true; });
    cdp.on("DOM.attributeModified", () => { cache.dirty = true; });
  }

  private findSession(userId: string, projectId: string): string | undefined {
    for (const entry of this.resourceManager.getAll()) {
      if (entry.userId === userId && entry.projectId === projectId) {
        return entry.sessionId;
      }
    }
    return undefined;
  }

  private async waitForCdp(host: string, port: number, maxWaitMs = 15_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      try {
        const res = await fetch(`http://${host}:${port}/json/version`);
        if (res.ok) return;
      } catch {}
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("Chrome CDP not ready within timeout");
  }

  /** Get the noVNC WebSocket URL for a session (container_ip:6080). */
  getNoVncTarget(sessionId: string): { host: string; port: number } | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    return { host: session.containerIp, port: NOVNC_PORT };
  }

  /** List all tracked containers with their status. */
  listContainers(): Array<{
    sessionId: string;
    userId: string;
    projectId: string;
    status: string;
    lastUsedAt: number;
  }> {
    return this.resourceManager.getAll().map((e) => ({
      sessionId: e.sessionId,
      userId: e.userId,
      projectId: e.projectId,
      status: e.status,
      lastUsedAt: e.lastUsedAt,
    }));
  }

  /** Get container status for a specific chat. */
  getContainerStatus(chatId: string): { status: "running" | "paused" | "none" } {
    const workspaceId = `chat-${chatId}`;
    const entry = this.resourceManager.getAll().find((e) => e.sessionId === workspaceId);
    if (!entry) return { status: "none" };
    return { status: entry.status };
  }

  /** Pause a container by session ID. */
  async pauseContainer(sessionId: string): Promise<void> {
    const entry = this.resourceManager.get(sessionId);
    if (!entry || entry.status !== "running") return;
    await this.resourceManager.onPause?.(sessionId);
    entry.status = "paused";
  }

  /** Resume a paused container by session ID. */
  async resumeContainer(sessionId: string): Promise<void> {
    await this.resourceManager.ensureRunning(sessionId);
  }

  /** Destroy a container by session ID. */
  async destroyContainer(sessionId: string): Promise<void> {
    const entry = this.resourceManager.getAll().find((e) => e.sessionId === sessionId);
    if (!entry) return;
    await this.destroySession(entry.userId, entry.projectId, sessionId);
  }

  /** Clean up all sessions on shutdown. */
  async destroyAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map((id) => this.destroySession("", "", id)));
    this.resourceManager.stop();
  }
}
