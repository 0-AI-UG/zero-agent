/**
 * Container manager — manages named containers with browser state,
 * idle reaping, and execution primitives.
 */
import { docker } from "./docker-client.ts";
import { CdpClient, connectToPage } from "./cdp.ts";
import { executeAction, type RefMap, type CursorState, type SnapshotCache } from "./browser.ts";
import { touchMarker, listFiles, detectChanges, readFiles, writeFiles, deleteFiles, saveSystemSnapshot, restoreSystemSnapshot, detectBlobDirs, tarWorkspaceDir, untarWorkspaceDir, manifest as filesManifest, STATIC_BLOB_DIRS } from "./files.ts";
import { fetchWithTimeout } from "./deferred.ts";
import { log } from "./logger.ts";
import { startSocketServer, stopSocketServer, socketPathFor, socketSubpathFor, ensureSocketDir } from "./socket-proxy.ts";
import type { DockerMount } from "./docker-client.ts";
import type * as http from "node:http";
import type { BrowserAction, BrowserResult, ContainerInfo, ExecResult } from "./types.ts";

const mgrLog = log.child({ module: "container-mgr" });

const DEFAULT_IMAGE = process.env.DEFAULT_IMAGE ?? "zero-session:latest";
const CDP_PORT = 9223;
const MAX_OUTPUT = 1_048_576; // 1 MB

const IDLE_TIMEOUT_MS = Number(process.env.IDLE_TIMEOUT_SECS ?? 600) * 1000;
const REAPER_INTERVAL_MS = 30_000;
const MAX_CONTAINERS = Number(process.env.MAX_CONTAINERS ?? 10);

// In-container mount target + socket file. The whole directory is
// mounted (from a named volume subpath or a host bind), and the socket
// lives inside it. Path is /run/zero/sock so we don't clobber /run.
const CONTAINER_SOCKET_DIR = "/run/zero";
const CONTAINER_SOCKET_PATH = `${CONTAINER_SOCKET_DIR}/sock`;

/**
 * Name of the Docker named volume holding per-container socket subdirs.
 * When set, session containers receive a VolumeOptions.Subpath mount of
 * this volume instead of a host bind-mount — this is the only mode that
 * works on Docker Desktop for macOS, because AF_UNIX endpoints on
 * bind-mounted macOS files aren't connectable from inside the Linux VM.
 * When unset, we fall back to the legacy host bind-mount (Linux host dev).
 */
const SOCKET_VOLUME = process.env.ZERO_RUNNER_SOCKET_VOLUME;

interface ContainerState {
  name: string;
  containerId: string;
  ip: string;
  cdp: CdpClient | null;
  refMap: RefMap;
  cursor: CursorState;
  snapshotCache: SnapshotCache;
  fileList: Set<string>; // for change detection
  blobDirs: string[];
  blobDirsExpiresAt: number;
  lock: Promise<void>;
  cdpReconnectAttempts: number;
  createdAt: number;
  lastUsedAt: number;
  busyCount: number;
  socketServer: http.Server | null;
}

export class ContainerManager {
  private containers = new Map<string, ContainerState>();
  private creationLocks = new Map<string, Promise<void>>();
  private destroying = new Set<string>();
  private imageReadyTag: string | null = null;
  private imageBuilding: Promise<string> | null = null;
  private readyNetworks = new Set<string>();
  private _dockerReady = false;
  private reaperInterval: ReturnType<typeof setInterval> | null = null;
  private latestScreenshots = new Map<string, { base64: string; title: string; url: string; timestamp: number }>();

  async waitForDocker(maxWaitMs = 30_000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      if (await docker.info()) {
        this._dockerReady = true;
        mgrLog.info("Docker daemon is ready");
        await this.cleanupOrphaned();
        this.startReaper();
        // Prebuild the session image so the first user doesn't pay the
        // build cost on their first request. Fire-and-forget: log on
        // failure but don't block startup.
        this.ensureImage(DEFAULT_IMAGE).catch((err) =>
          mgrLog.error("prebuild of session image failed", { error: String(err) }),
        );
        return true;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    mgrLog.warn("Docker daemon not available after timeout");
    return false;
  }

  isReady(): boolean {
    return this._dockerReady;
  }

  // -- Container lifecycle --

  async create(name: string, opts?: {
    image?: string;
    env?: string[];
    memory?: number;
    cpus?: number;
    network?: string;
  }): Promise<ContainerInfo> {
    const existing = this.containers.get(name);
    if (existing) {
      existing.lastUsedAt = Date.now();
      return { name, ip: existing.ip, status: "running", createdAt: existing.createdAt, lastUsedAt: existing.lastUsedAt };
    }

    if (this.containers.size >= MAX_CONTAINERS) {
      throw new Error(`Container limit reached (${MAX_CONTAINERS}). Destroy an idle container first.`);
    }

    // Deduplicate concurrent creation
    const inflight = this.creationLocks.get(name);
    if (inflight) {
      await inflight;
      const s = this.containers.get(name);
      if (!s) throw new Error("Container creation failed");
      return { name, ip: s.ip, status: "running", createdAt: s.createdAt, lastUsedAt: s.lastUsedAt };
    }

    let resolve: () => void;
    const lock = new Promise<void>((r) => { resolve = r; });
    this.creationLocks.set(name, lock);

    try {
      return await this._create(name, opts);
    } finally {
      this.creationLocks.delete(name);
      resolve!();
    }
  }

  private async _create(name: string, opts?: {
    image?: string;
    env?: string[];
    memory?: number;
    cpus?: number;
    network?: string;
  }): Promise<ContainerInfo> {
    const startTime = Date.now();
    const image = opts?.image ?? DEFAULT_IMAGE;
    mgrLog.info("creating container", { name, image });

    const resolvedImage = await this.ensureImage(image);

    const network = opts?.network ?? `runner-net-${name}`;
    await this.ensureNetwork(network);

    // Start a per-container Unix socket the in-container `zero` CLI/SDK
    // will talk to. Identity is established by the mount itself (either
    // a file bind-mount or a volume subpath mount) — so this surface
    // needs no network attach, no DNS, no token, no source-IP check.
    await ensureSocketDir();
    const socketServer = await startSocketServer(this, { name });

    const baseEnv = opts?.env ?? [];
    const env = [...baseEnv, `ZERO_PROXY_URL=unix:${CONTAINER_SOCKET_PATH}`];

    // Pick the socket transport shape. SOCKET_VOLUME implies we're a
    // containerized runner sharing a named volume with sessions; otherwise
    // we fall back to a plain host bind-mount of the socket file.
    let mounts: DockerMount[] | undefined;
    let binds: string[] | undefined;
    if (SOCKET_VOLUME) {
      mounts = [
        {
          Type: "volume",
          Source: SOCKET_VOLUME,
          Target: CONTAINER_SOCKET_DIR,
          VolumeOptions: { Subpath: socketSubpathFor(name) },
        },
      ];
    } else {
      const hostSocketPath = socketPathFor(name);
      // Host bind-mount the whole per-container directory (not just the
      // file) so the runner can re-create the socket without the bind
      // losing track of it.
      const hostDir = hostSocketPath.replace(/\/sock$/, "");
      binds = [`${hostDir}:${CONTAINER_SOCKET_DIR}`];
    }

    try {
      await docker.removeContainer(name).catch(() => {});

      const containerId = await docker.createAndStartContainer({
        name,
        image: resolvedImage,
        network,
        env,
        binds,
        mounts,
        memory: opts?.memory ?? 1024 * 1024 * 1024,
        cpus: opts?.cpus ?? 2,
        pidsLimit: 512,
      });

      const ip = await docker.getContainerIp(name);
      if (!ip) throw new Error("Could not determine container IP");

      mgrLog.info("waiting for CDP", { name, ip });
      await this.waitForCdp(ip, CDP_PORT);

      const { cdp } = await connectToPage(ip, CDP_PORT);
      const snapshotCache: SnapshotCache = { dirty: true, lastContent: "" };

      const state: ContainerState = {
        name,
        containerId,
        ip,
        cdp,
        refMap: new Map(),
        cursor: { x: 0, y: 0 },
        snapshotCache,
        fileList: new Set(),
        blobDirs: [...STATIC_BLOB_DIRS],
        blobDirsExpiresAt: 0,
        lock: Promise.resolve(),
        cdpReconnectAttempts: 0,
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        busyCount: 0,
        socketServer,
      };

      this.registerDomListener(cdp, snapshotCache);
      cdp.onClose = () => { state.cdp = null; };
      this.containers.set(name, state);

      mgrLog.info("container created", { name, containerId: containerId.slice(0, 12), ip, totalMs: Date.now() - startTime });

      return { name, ip, status: "running", createdAt: state.createdAt, lastUsedAt: state.lastUsedAt };
    } catch (err) {
      mgrLog.error("container creation failed, cleaning up", { name, error: String(err) });
      await docker.removeContainer(name).catch(() => {});
      await stopSocketServer(socketServer, name).catch(() => {});
      throw err;
    }
  }

  async destroy(name: string): Promise<void> {
    if (this.destroying.has(name)) return;
    this.destroying.add(name);

    try {
      const state = this.containers.get(name);
      this.containers.delete(name);
      this.latestScreenshots.delete(name);

      if (!state) return;

      try { state.cdp?.close(); } catch {}
      try { await docker.removeContainer(name); } catch (err) {
        mgrLog.warn("failed to remove container", { name, error: String(err) });
      }
      if (state.socketServer) {
        await stopSocketServer(state.socketServer, name).catch((err) => {
          mgrLog.warn("failed to stop socket server", { name, error: String(err) });
        });
      }

      mgrLog.info("container destroyed", { name });
    } finally {
      this.destroying.delete(name);
    }
  }

  touch(name: string): boolean {
    const state = this.containers.get(name);
    if (!state) return false;
    state.lastUsedAt = Date.now();
    return true;
  }

  get(name: string): ContainerInfo | null {
    const state = this.containers.get(name);
    if (!state) return null;
    return { name, ip: state.ip, status: "running", createdAt: state.createdAt, lastUsedAt: state.lastUsedAt };
  }

list(): ContainerInfo[] {
    return [...this.containers.values()].map((s) => ({
      name: s.name,
      ip: s.ip,
      status: "running",
      createdAt: s.createdAt,
      lastUsedAt: s.lastUsedAt,
    }));
  }

  async destroyAll(): Promise<void> {
    if (this.reaperInterval) {
      clearInterval(this.reaperInterval);
      this.reaperInterval = null;
    }
    const names = [...this.containers.keys()];
    await Promise.allSettled(names.map((name) => this.destroy(name)));
  }

  // -- Command execution --

  async exec(name: string, cmd: string[], opts?: { timeout?: number; workingDir?: string }): Promise<ExecResult> {
    const state = this.containers.get(name);
    if (!state) throw new Error(`Container "${name}" not found`);
    state.lastUsedAt = Date.now();
    return docker.exec(name, cmd, opts);
  }

  async bash(name: string, command: string, opts?: { timeout?: number; workingDir?: string }): Promise<ExecResult> {
    const state = this.containers.get(name);
    if (!state) throw new Error(`Container "${name}" not found`);
    state.lastUsedAt = Date.now();
    state.busyCount++;

    try {
      // Touch marker before execution for change detection
      await touchMarker(name);

      const timeout = opts?.timeout ?? 120_000;

      let result: ExecResult;
      try {
        result = await docker.exec(name, ["bash", "-c", command], {
          timeout,
          workingDir: opts?.workingDir ?? "/project",
        });
      } catch (err) {
        const errMsg = String(err);
        if (errMsg.includes("OCI runtime") || errMsg.includes("container breakout")) {
          mgrLog.error("exec OCI error, destroying broken container", { name, error: errMsg });
          this.containers.delete(name);
          await docker.removeContainer(name).catch(() => {});
        }
        throw err;
      }

      const stdout = result.stdout.length > MAX_OUTPUT
        ? result.stdout.slice(0, MAX_OUTPUT) + "\n[output truncated at 1MB]"
        : result.stdout;
      const stderr = result.stderr.length > MAX_OUTPUT
        ? result.stderr.slice(0, MAX_OUTPUT) + "\n[output truncated at 1MB]"
        : result.stderr;

      return { stdout, stderr, exitCode: result.exitCode };
    } finally {
      state.busyCount--;
    }
  }

  // -- File operations --

  async getBlobDirs(name: string): Promise<string[]> {
    const state = this.containers.get(name);
    if (!state) throw new Error(`Container "${name}" not found`);
    if (Date.now() < state.blobDirsExpiresAt && state.blobDirs.length > 0) {
      return state.blobDirs;
    }
    state.blobDirs = await detectBlobDirs(name);
    state.blobDirsExpiresAt = Date.now() + 60_000;
    return state.blobDirs;
  }

  async touchChangeMarker(name: string): Promise<void> {
    if (!this.containers.has(name)) throw new Error(`Container "${name}" not found`);
    this.containers.get(name)!.lastUsedAt = Date.now();
    await touchMarker(name);
    const blobDirs = await this.getBlobDirs(name);
    this.containers.get(name)!.fileList = await listFiles(name, "/project", blobDirs);
  }

  async getChanges(name: string): Promise<{ changed: string[]; deleted: string[] }> {
    const state = this.containers.get(name);
    if (!state) throw new Error(`Container "${name}" not found`);
    state.lastUsedAt = Date.now();
    const blobDirs = await this.getBlobDirs(name);
    const result = await detectChanges(name, state.fileList, "/project", blobDirs);
    state.fileList = await listFiles(name, "/project", blobDirs);
    return result;
  }

  async saveBlob(name: string, dir: string): Promise<Buffer | null> {
    const state = this.containers.get(name);
    if (!state) throw new Error(`Container "${name}" not found`);
    state.lastUsedAt = Date.now();
    return tarWorkspaceDir(name, dir);
  }

  async restoreBlob(name: string, dir: string, data: Buffer): Promise<boolean> {
    const state = this.containers.get(name);
    if (!state) throw new Error(`Container "${name}" not found`);
    state.lastUsedAt = Date.now();
    // Invalidate blob dir cache since contents changed
    state.blobDirsExpiresAt = 0;
    return untarWorkspaceDir(name, dir, data);
  }

  async readFiles(name: string, paths: string[]): Promise<Array<{ path: string; data: string; sizeBytes: number }>> {
    if (!this.containers.has(name)) throw new Error(`Container "${name}" not found`);
    this.containers.get(name)!.lastUsedAt = Date.now();
    return readFiles(name, paths);
  }

  async writeFiles(name: string, files: Array<{ path: string; data: string }>): Promise<void> {
    if (!this.containers.has(name)) throw new Error(`Container "${name}" not found`);
    this.containers.get(name)!.lastUsedAt = Date.now();
    const buffers = files.map(f => ({ path: f.path, data: Buffer.from(f.data, "base64") }));
    await writeFiles(name, buffers);
  }

  async deleteFiles(name: string, paths: string[]): Promise<void> {
    if (!this.containers.has(name)) throw new Error(`Container "${name}" not found`);
    this.containers.get(name)!.lastUsedAt = Date.now();
    await deleteFiles(name, paths);
  }

  async manifest(name: string, dir?: string): Promise<Record<string, string>> {
    const state = this.containers.get(name);
    if (!state) throw new Error(`Container "${name}" not found`);
    state.lastUsedAt = Date.now();
    const blobDirs = await this.getBlobDirs(name);
    return filesManifest(name, dir ?? "/project", blobDirs);
  }

  async listFiles(name: string, dir?: string): Promise<string[]> {
    if (!this.containers.has(name)) throw new Error(`Container "${name}" not found`);
    this.containers.get(name)!.lastUsedAt = Date.now();
    const fileSet = await listFiles(name, dir);
    return [...fileSet];
  }

  async saveSnapshot(name: string): Promise<Buffer | null> {
    const state = this.containers.get(name);
    if (!state) throw new Error(`Container "${name}" not found`);
    state.lastUsedAt = Date.now();
    state.busyCount++;
    try {
      return await saveSystemSnapshot(name);
    } finally {
      state.busyCount--;
    }
  }

  async restoreSnapshot(name: string, data: Buffer): Promise<boolean> {
    if (!this.containers.has(name)) throw new Error(`Container "${name}" not found`);
    return restoreSystemSnapshot(name, data);
  }

  // -- Browser --

  async browserAction(name: string, action: BrowserAction, stealth?: boolean): Promise<BrowserResult> {
    const state = this.containers.get(name);
    if (!state) throw new Error(`Container "${name}" not found`);

    state.busyCount++;
    state.lastUsedAt = Date.now();

    try {
      return await this.withLock(name, async () => {
        // Auto-reconnect CDP if disconnected
        if (!state.cdp || !state.cdp.connected) {
          if (state.cdpReconnectAttempts >= 3) {
            throw new Error("Browser crashed and could not be reconnected.");
          }
          state.cdpReconnectAttempts++;
          mgrLog.info("CDP disconnected, reconnecting", { name, attempt: state.cdpReconnectAttempts });
          await this.waitForCdp(state.ip, CDP_PORT, 5000);
          const { cdp: newCdp } = await connectToPage(state.ip, CDP_PORT);
          state.cdp = newCdp;
          newCdp.onClose = () => { state.cdp = null; };
          state.cdpReconnectAttempts = 0;
          state.snapshotCache.dirty = true;
          this.registerDomListener(newCdp, state.snapshotCache);
        }

        const result = await executeAction(state.cdp, action, state.ip, CDP_PORT, state.refMap, {
          stealth, cursor: state.cursor, snapshotCache: state.snapshotCache,
        });

        // Auto-capture screenshot for live preview
        if (action.type !== "screenshot" && state.cdp) {
          state.cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 50 }).then((capture) => {
            const info = result.type === "done" || result.type === "snapshot" || result.type === "screenshot"
              ? { title: (result as any).title ?? "", url: (result as any).url ?? "" }
              : { title: "", url: "" };
            this.latestScreenshots.set(name, { base64: capture.data, title: info.title, url: info.url, timestamp: Date.now() });
          }).catch(() => {});
        } else if (action.type === "screenshot" && result.type === "screenshot") {
          this.latestScreenshots.set(name, { base64: result.base64, title: result.title, url: result.url, timestamp: Date.now() });
        }

        return result;
      });
    } finally {
      state.busyCount--;
    }
  }

  getLatestScreenshot(name: string): { base64: string; title: string; url: string; timestamp: number } | null {
    return this.latestScreenshots.get(name) ?? null;
  }

  // -- Helpers --

  private registerDomListener(cdp: CdpClient, cache: SnapshotCache): void {
    cdp.send("DOM.enable").catch(() => {});
    cdp.on("DOM.documentUpdated", () => { cache.dirty = true; });
    cdp.on("DOM.childNodeInserted", () => { cache.dirty = true; });
    cdp.on("DOM.childNodeRemoved", () => { cache.dirty = true; });
    cdp.on("DOM.attributeModified", () => { cache.dirty = true; });
  }

  private async withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const state = this.containers.get(name);
    if (!state) throw new Error("Container not found");
    const prev = state.lock;
    let resolve: () => void;
    state.lock = new Promise<void>((r) => { resolve = r; });
    await prev;
    try { return await fn(); }
    finally { resolve!(); }
  }

  private async waitForCdp(host: string, port: number, maxWaitMs = 30_000): Promise<void> {
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

  private async ensureImage(image: string): Promise<string> {
    if (this.imageReadyTag) return this.imageReadyTag;
    if (this.imageBuilding) return this.imageBuilding;

    this.imageBuilding = (async () => {
      if (await docker.imageExists(image)) {
        this.imageReadyTag = image;
        return image;
      }

      const registryImage = process.env.REGISTRY_IMAGE ?? image;
      mgrLog.info("pulling image", { image: registryImage });
      await docker.pullImage(registryImage);
      if (registryImage !== image) {
        await docker.tagImage(registryImage, image);
      }
      this.imageReadyTag = image;
      return image;
    })();

    return this.imageBuilding;
  }

  private async ensureNetwork(name: string): Promise<void> {
    if (this.readyNetworks.has(name)) return;
    await docker.ensureNetwork(name);
    this.readyNetworks.add(name);
  }

  private async cleanupOrphaned(): Promise<void> {
    try {
      const containers = await docker.listContainers({ all: true });
      const orphaned = containers.filter((c) =>
        c.Names.some((n) => /^\/(session-|runner-)/.test(n)),
      );
      if (orphaned.length === 0) return;

      mgrLog.info("cleaning up orphaned containers", { count: orphaned.length });
      await Promise.allSettled(
        orphaned.map(async (c) => {
          const name = c.Names[0]?.replace(/^\//, "") ?? c.Id;
          await docker.removeContainer(name).catch(() => {});
        }),
      );
    } catch (err) {
      mgrLog.warn("failed to cleanup orphaned containers", { error: String(err) });
    }
  }

  // -- Idle reaper --

  private startReaper(): void {
    this.reaperInterval = setInterval(() => this.reap(), REAPER_INTERVAL_MS);
  }

  private async reap(): Promise<void> {
    const now = Date.now();
    for (const [name, state] of this.containers) {
      if (state.busyCount > 0) continue;
      if (now - state.lastUsedAt > IDLE_TIMEOUT_MS) {
        mgrLog.info("reaper destroying idle container", { name, idleMs: now - state.lastUsedAt });
        await this.destroy(name).catch((err) =>
          mgrLog.warn("reaper destroy failed", { name, error: String(err) })
        );
      }
    }
  }
}

