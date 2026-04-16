/**
 * Container manager — manages named containers with browser state,
 * idle reaping, and execution primitives.
 */
import { docker } from "./docker-client.ts";
import { CdpClient, connectToPage } from "./cdp.ts";
import { executeAction, type RefMap, type CursorState, type SnapshotCache } from "./browser.ts";
import { touchMarker, listFiles, detectChanges, readFiles, writeFiles, deleteFiles, saveSystemSnapshot, saveSystemSnapshotStream, restoreSystemSnapshot, restoreSystemSnapshotStream, detectBlobDirs, tarWorkspaceDir, tarWorkspaceDirStream, untarWorkspaceDir, untarWorkspaceDirStream, manifest as filesManifest, STATIC_BLOB_DIRS } from "./files.ts";
import { fetchWithTimeout } from "./deferred.ts";
import { log } from "./logger.ts";
import { startSocketServer, stopSocketServer, socketPathFor, ensureSocketDir, SOCKET_DIR } from "./socket-proxy.ts";
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
 * Name of the Docker named volume holding per-container socket subdirs
 * when the runner itself is containerized. May be set explicitly via
 * ZERO_RUNNER_SOCKET_VOLUME, or auto-detected from the runner's own
 * mounts (whichever volume is mounted at SOCKET_DIR). When resolved, the
 * runner bind-mounts a subdirectory of the volume's host Mountpoint into
 * each session at CONTAINER_SOCKET_DIR — this works on every Docker
 * version, unlike VolumeOptions.Subpath which requires Docker ≥ 25.
 */
const SOCKET_VOLUME_ENV = process.env.ZERO_RUNNER_SOCKET_VOLUME;

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
  /** When the runner is itself containerized, this holds its container ID so it can join session networks. */
  private selfContainerId: string | null = null;
  /**
   * Host-side path that backs SOCKET_DIR inside the runner. When the
   * runner is containerized with a named volume at SOCKET_DIR, this is
   * the volume's Mountpoint on the Docker daemon host, which we can hand
   * to the daemon as a plain bind source for session containers. When
   * the runner runs on the host, this equals SOCKET_DIR itself.
   */
  private hostSocketDir: string = SOCKET_DIR;

  async waitForDocker(maxWaitMs = 30_000): Promise<boolean> {
    mgrLog.info("waiting for Docker daemon", { maxWaitMs });
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      if (await docker.info()) {
        this._dockerReady = true;
        mgrLog.info("Docker daemon is ready", { waitedMs: Date.now() - start });
        await this.detectSelfContainer();
        await this.cleanupOrphaned();
        this.startReaper();
        mgrLog.info("prebuilding session image", { image: DEFAULT_IMAGE });
        this.ensureImage(DEFAULT_IMAGE)
          .then(() => mgrLog.info("session image ready", { image: DEFAULT_IMAGE, totalMs: Date.now() - start }))
          .catch((err) => mgrLog.error("prebuild of session image failed", { error: String(err) }));
        return true;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    mgrLog.warn("Docker daemon not available after timeout", { waitedMs: maxWaitMs });
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
      mgrLog.debug("reusing existing container", { name, ip: existing.ip });
      return { name, ip: existing.ip, status: "running", created: false, createdAt: existing.createdAt, lastUsedAt: existing.lastUsedAt };
    }

    if (this.containers.size >= MAX_CONTAINERS) {
      mgrLog.warn("container limit reached", { limit: MAX_CONTAINERS, active: this.containers.size });
      throw new Error(`Container limit reached (${MAX_CONTAINERS}). Destroy an idle container first.`);
    }

    // Deduplicate concurrent creation
    const inflight = this.creationLocks.get(name);
    if (inflight) {
      mgrLog.info("waiting on inflight container creation", { name });
      await inflight;
      const s = this.containers.get(name);
      if (!s) throw new Error("Container creation failed");
      return { name, ip: s.ip, status: "running", created: false, createdAt: s.createdAt, lastUsedAt: s.lastUsedAt };
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

    const imageStart = Date.now();
    const resolvedImage = await this.ensureImage(image);
    mgrLog.info("image ready", { name, image: resolvedImage, imageMs: Date.now() - imageStart });

    const network = opts?.network ?? `runner-net-${name}`;
    await this.ensureNetwork(network);
    mgrLog.debug("network ready", { name, network });

    // Start a per-container Unix socket the in-container `zero` CLI/SDK
    // will talk to. Identity is established by the mount itself (either
    // a file bind-mount or a volume subpath mount) — so this surface
    // needs no network attach, no DNS, no token, no source-IP check.
    await ensureSocketDir();
    const socketServer = await startSocketServer(this, { name });

    const baseEnv = opts?.env ?? [];
    const env = [...baseEnv, `ZERO_PROXY_URL=unix:${CONTAINER_SOCKET_PATH}`];

    // Bind-mount the per-session socket directory into the session at
    // CONTAINER_SOCKET_DIR. `hostSocketDir` is the host-daemon-visible
    // path (resolved once at startup — either the runner's own host
    // SOCKET_DIR or the Mountpoint of the named volume mounted there).
    // We avoid VolumeOptions.Subpath because it requires Docker ≥ 25 and
    // silently misbehaves on older/quirky daemons (Hetzner default
    // Debian package, some OrbStack versions). Plain host-path binds
    // work everywhere.
    const sessionHostDir = `${this.hostSocketDir}/${name}`;
    const binds = [`${sessionHostDir}:${CONTAINER_SOCKET_DIR}`];
    const mounts: DockerMount[] | undefined = undefined;

    try {
      await docker.removeContainer(name).catch(() => {});

      const containerId = await docker.createAndStartContainer({
        name,
        image: resolvedImage,
        network,
        env,
        binds,
        mounts,
        memory: opts?.memory ?? 512 * 1024 * 1024,
        cpus: opts?.cpus ?? 1,
        pidsLimit: 512,
      });

      const ip = await docker.getContainerIp(name);
      if (!ip) throw new Error("Could not determine container IP");

      mgrLog.info("container started, waiting for CDP", { name, containerId: containerId.slice(0, 12), ip });
      const cdpStart = Date.now();
      await this.waitForCdp(ip, CDP_PORT);
      mgrLog.info("CDP ready", { name, cdpMs: Date.now() - cdpStart });

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

      return { name, ip, status: "running", created: true, createdAt: state.createdAt, lastUsedAt: state.lastUsedAt };
    } catch (err) {
      // Capture container logs before teardown to diagnose startup failures
      const containerLogs = await docker.getContainerLogs(name, 50).catch(() => "(no logs)");
      mgrLog.error("container creation failed, cleaning up", { name, error: String(err), containerLogs });
      await docker.removeContainer(name).catch(() => {});
      await stopSocketServer(socketServer, name).catch(() => {});
      throw err;
    }
  }

  async destroy(name: string): Promise<void> {
    if (this.destroying.has(name)) {
      mgrLog.debug("destroy already in progress", { name });
      return;
    }
    this.destroying.add(name);
    mgrLog.info("destroying container", { name });

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

      // Clean up the per-session network and disconnect the runner from it
      const network = `runner-net-${name}`;
      if (this.selfContainerId) {
        await docker.disconnectNetwork(network, this.selfContainerId).catch(() => {});
      }
      await docker.removeNetwork(network).catch(() => {});
      this.readyNetworks.delete(network);

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
    return { name, ip: state.ip, status: "running", created: false, createdAt: state.createdAt, lastUsedAt: state.lastUsedAt };
  }

list(): ContainerInfo[] {
    return [...this.containers.values()].map((s) => ({
      name: s.name,
      ip: s.ip,
      status: "running",
      created: false,
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
    mgrLog.info("destroying all containers", { count: names.length });
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
    const bashStart = Date.now();
    mgrLog.info("bash exec", { name, command: command.slice(0, 200), timeout: opts?.timeout });

    try {
      // Touch marker before execution for change detection
      await touchMarker(name);

      const timeout = opts?.timeout ?? 120_000;

      let result: ExecResult;
      try {
        result = await docker.exec(name, ["bash", "-c", command], {
          timeout,
          workingDir: opts?.workingDir ?? "/workspace",
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

      mgrLog.info("bash exec done", { name, exitCode: result.exitCode, durationMs: Date.now() - bashStart, stdoutLen: stdout.length, stderrLen: stderr.length });
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
    this.containers.get(name)!.fileList = await listFiles(name, "/workspace", blobDirs);
  }

  async getChanges(name: string): Promise<{ changed: string[]; deleted: string[] }> {
    const state = this.containers.get(name);
    if (!state) throw new Error(`Container "${name}" not found`);
    state.lastUsedAt = Date.now();
    const blobDirs = await this.getBlobDirs(name);
    const result = await detectChanges(name, state.fileList, "/workspace", blobDirs);
    state.fileList = await listFiles(name, "/workspace", blobDirs);
    return result;
  }

  async saveBlob(name: string, dir: string): Promise<Buffer | null> {
    const state = this.containers.get(name);
    if (!state) throw new Error(`Container "${name}" not found`);
    state.lastUsedAt = Date.now();
    return tarWorkspaceDir(name, dir);
  }

  async saveBlobStream(name: string, dir: string): Promise<ReadableStream<Uint8Array> | null> {
    const state = this.containers.get(name);
    if (!state) throw new Error(`Container "${name}" not found`);
    state.lastUsedAt = Date.now();
    return tarWorkspaceDirStream(name, dir);
  }

  async restoreBlob(name: string, dir: string, data: Buffer): Promise<boolean> {
    const state = this.containers.get(name);
    if (!state) throw new Error(`Container "${name}" not found`);
    state.lastUsedAt = Date.now();
    // Invalidate blob dir cache since contents changed
    state.blobDirsExpiresAt = 0;
    return untarWorkspaceDir(name, dir, data);
  }

  async restoreBlobStream(name: string, dir: string, dataStream: ReadableStream<Uint8Array>, dataSize: number): Promise<boolean> {
    const state = this.containers.get(name);
    if (!state) throw new Error(`Container "${name}" not found`);
    state.lastUsedAt = Date.now();
    state.blobDirsExpiresAt = 0;
    return untarWorkspaceDirStream(name, dir, dataStream, dataSize);
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
    return filesManifest(name, dir ?? "/workspace", blobDirs);
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

  async saveSnapshotStream(name: string): Promise<ReadableStream<Uint8Array> | null> {
    const state = this.containers.get(name);
    if (!state) throw new Error(`Container "${name}" not found`);
    state.lastUsedAt = Date.now();
    state.busyCount++;
    try {
      return await saveSystemSnapshotStream(name);
    } finally {
      state.busyCount--;
    }
  }

  async restoreSnapshot(name: string, data: Buffer): Promise<boolean> {
    if (!this.containers.has(name)) throw new Error(`Container "${name}" not found`);
    return restoreSystemSnapshot(name, data);
  }

  async restoreSnapshotStream(name: string, dataStream: ReadableStream<Uint8Array>, dataSize: number): Promise<boolean> {
    if (!this.containers.has(name)) throw new Error(`Container "${name}" not found`);
    return restoreSystemSnapshotStream(name, dataStream, dataSize);
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

  private async waitForCdp(host: string, port: number, maxWaitMs = 45_000): Promise<void> {
    const start = Date.now();
    let attempts = 0;
    while (Date.now() - start < maxWaitMs) {
      attempts++;
      try {
        const res = await fetchWithTimeout(`http://${host}:${port}/json/version`, { timeout: 2000 });
        if (res.ok) {
          mgrLog.debug("CDP responded", { host, attempts, elapsedMs: Date.now() - start });
          return;
        }
        mgrLog.debug("CDP not ready", { host, status: res.status, attempts });
      } catch (err) {
        if (attempts === 1 || attempts % 10 === 0) {
          mgrLog.debug("CDP probe failed", { host, attempts, error: String(err).slice(0, 100) });
        }
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`Chrome CDP not ready within timeout (${maxWaitMs}ms, ${attempts} attempts)`);
  }

  private async ensureImage(image: string): Promise<string> {
    if (this.imageReadyTag) {
      mgrLog.debug("image already cached", { image: this.imageReadyTag });
      return this.imageReadyTag;
    }
    if (this.imageBuilding) {
      mgrLog.debug("waiting on inflight image build/pull", { image });
      return this.imageBuilding;
    }

    this.imageBuilding = (async () => {
      if (await docker.imageExists(image)) {
        mgrLog.info("image exists locally", { image });
        this.imageReadyTag = image;
        return image;
      }

      const registryImage = process.env.REGISTRY_IMAGE ?? image;
      mgrLog.info("pulling image from registry", { image: registryImage });
      const pullStart = Date.now();
      await docker.pullImage(registryImage);
      mgrLog.info("image pulled", { image: registryImage, pullMs: Date.now() - pullStart });
      if (registryImage !== image) {
        await docker.tagImage(registryImage, image);
        mgrLog.info("image tagged", { from: registryImage, to: image });
      }
      this.imageReadyTag = image;
      return image;
    })();

    return this.imageBuilding;
  }

  private async ensureNetwork(name: string): Promise<void> {
    if (this.readyNetworks.has(name)) return;
    await docker.ensureNetwork(name);
    // When the runner itself is containerized, it must join the session
    // network to reach session containers by IP.
    if (this.selfContainerId) {
      await docker.connectNetwork(name, this.selfContainerId).catch((err) => {
        // "already connected" is fine — ignore
        if (!String(err).includes("already exists")) {
          mgrLog.warn("failed to join session network", { network: name, error: String(err) });
        }
      });
      mgrLog.debug("runner joined session network", { network: name });
    }
    this.readyNetworks.add(name);
  }

  /**
   * Detect whether the runner is itself running inside a Docker container.
   * If so, store the container ID so we can join session networks, and
   * resolve the host-side path backing SOCKET_DIR so we can hand it to
   * dockerd as a plain bind source for session containers.
   */
  private async detectSelfContainer(): Promise<void> {
    try {
      const fs = await import("node:fs/promises");
      // Docker sets the hostname to the short container ID
      const hostname = (await fs.readFile("/etc/hostname", "utf-8")).trim();
      // Verify it's actually a running container
      if (hostname && await docker.isContainerRunning(hostname)) {
        this.selfContainerId = hostname;
        mgrLog.info("runner is containerized", { containerId: hostname });
        await this.resolveHostSocketDir(hostname);
        return;
      }
    } catch {}
    mgrLog.info("runner is running on host (not containerized)", { hostSocketDir: this.hostSocketDir });
  }

  /**
   * Figure out the host-side path that backs SOCKET_DIR inside the
   * runner. Preference order:
   *   1. The named volume from the runner's own Mounts whose
   *      Destination equals SOCKET_DIR → use its host Mountpoint.
   *   2. A bind-mount at SOCKET_DIR → use its host Source.
   *   3. Explicit ZERO_RUNNER_SOCKET_VOLUME env var → look up its
   *      Mountpoint.
   * If nothing resolves, we leave hostSocketDir = SOCKET_DIR, which
   * means the runner and dockerd share a filesystem view (bind-mounted
   * /var/run/docker.sock in a rootful setup with a shared host mount).
   */
  private async resolveHostSocketDir(containerId: string): Promise<void> {
    try {
      const info = await docker.inspectContainer(containerId);
      const mount = info.Mounts?.find((m) => m.Destination === SOCKET_DIR);
      if (mount) {
        if (mount.Type === "volume" && mount.Name) {
          const vol = await docker.inspectVolume(mount.Name);
          if (vol?.Mountpoint) {
            this.hostSocketDir = vol.Mountpoint;
            mgrLog.info("resolved socket dir via volume", { volume: mount.Name, hostSocketDir: this.hostSocketDir });
            return;
          }
        } else if (mount.Type === "bind" && mount.Source) {
          this.hostSocketDir = mount.Source;
          mgrLog.info("resolved socket dir via bind mount", { hostSocketDir: this.hostSocketDir });
          return;
        }
      }
      if (SOCKET_VOLUME_ENV) {
        const vol = await docker.inspectVolume(SOCKET_VOLUME_ENV);
        if (vol?.Mountpoint) {
          this.hostSocketDir = vol.Mountpoint;
          mgrLog.info("resolved socket dir via env volume", { volume: SOCKET_VOLUME_ENV, hostSocketDir: this.hostSocketDir });
          return;
        }
      }
      mgrLog.warn("could not resolve host-side socket dir; session socket mounts may fail", { socketDir: SOCKET_DIR });
    } catch (err) {
      mgrLog.warn("failed to resolve host socket dir", { error: String(err) });
    }
  }

  private async cleanupOrphaned(): Promise<void> {
    try {
      const containers = await docker.listContainers({ all: true });
      const orphaned = containers.filter((c) =>
        c.Names.some((n) => /^\/(session-|runner-)/.test(n)),
      );
      if (orphaned.length === 0) {
        mgrLog.info("no orphaned containers found");
        return;
      }

      const names = orphaned.map((c) => c.Names[0]?.replace(/^\//, "") ?? c.Id);
      mgrLog.info("cleaning up orphaned containers", { count: orphaned.length, names });
      await Promise.allSettled(
        orphaned.map(async (c) => {
          const name = c.Names[0]?.replace(/^\//, "") ?? c.Id;
          await docker.removeContainer(name).catch((err) => {
            mgrLog.warn("failed to remove orphaned container", { name, error: String(err) });
          });
        }),
      );
      mgrLog.info("orphan cleanup complete");
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

