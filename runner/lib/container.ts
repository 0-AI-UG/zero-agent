/**
 * Container manager — manages named containers with browser state,
 * idle reaping, and execution primitives.
 */
import * as path from "node:path";
import { docker } from "./docker-client.ts";
import { CdpClient, connectToPage } from "./cdp.ts";
import { executeAction, type RefMap, type CursorState, type SnapshotCache } from "./browser.ts";
import { touchMarker, listFiles, detectChanges, readFiles, writeFiles, deleteFiles, saveSystemSnapshot, restoreSystemSnapshot } from "./files.ts";
import { fetchWithTimeout } from "./deferred.ts";
import { log } from "./logger.ts";
import type { BrowserAction, BrowserResult, ContainerInfo, ExecResult } from "./types.ts";

const mgrLog = log.child({ module: "container-mgr" });

const DEFAULT_IMAGE = process.env.DEFAULT_IMAGE ?? "zero-session:latest";
const CDP_PORT = 9223;
const MAX_OUTPUT = 1_048_576; // 1 MB

const IDLE_TIMEOUT_MS = Number(process.env.IDLE_TIMEOUT_SECS ?? 600) * 1000;
const REAPER_INTERVAL_MS = 30_000;
const MAX_CONTAINERS = Number(process.env.MAX_CONTAINERS ?? 10);

interface ContainerState {
  name: string;
  containerId: string;
  ip: string;
  cdp: CdpClient | null;
  refMap: RefMap;
  cursor: CursorState;
  snapshotCache: SnapshotCache;
  fileList: Set<string>; // for change detection
  lock: Promise<void>;
  cdpReconnectAttempts: number;
  createdAt: number;
  lastUsedAt: number;
  busyCount: number;
}

export class ContainerManager {
  private containers = new Map<string, ContainerState>();
  private creationLocks = new Map<string, Promise<void>>();
  private destroying = new Set<string>();
  private imageReady = false;
  private imageBuilding: Promise<void> | null = null;
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

    await this.ensureImage(image);

    const network = opts?.network ?? `runner-net-${name}`;
    await this.ensureNetwork(network);

    try {
      await docker.removeContainer(name).catch(() => {});

      const containerId = await docker.createAndStartContainer({
        name,
        image,
        network,
        env: opts?.env,
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
        lock: Promise.resolve(),
        cdpReconnectAttempts: 0,
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        busyCount: 0,
      };

      this.registerDomListener(cdp, snapshotCache);
      cdp.onClose = () => { state.cdp = null; };
      this.containers.set(name, state);

      mgrLog.info("container created", { name, containerId: containerId.slice(0, 12), ip, totalMs: Date.now() - startTime });

      return { name, ip, status: "running", createdAt: state.createdAt, lastUsedAt: state.lastUsedAt };
    } catch (err) {
      mgrLog.error("container creation failed, cleaning up", { name, error: String(err) });
      await docker.removeContainer(name).catch(() => {});
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

      return { stdout, stderr, exitCode: result.exitCode };
    } finally {
      state.busyCount--;
    }
  }

  // -- File operations --

  async touchChangeMarker(name: string): Promise<void> {
    if (!this.containers.has(name)) throw new Error(`Container "${name}" not found`);
    this.containers.get(name)!.lastUsedAt = Date.now();
    await touchMarker(name);
    this.containers.get(name)!.fileList = await listFiles(name);
  }

  async getChanges(name: string): Promise<{ changed: string[]; deleted: string[] }> {
    const state = this.containers.get(name);
    if (!state) throw new Error(`Container "${name}" not found`);
    state.lastUsedAt = Date.now();
    const result = await detectChanges(name, state.fileList);
    state.fileList = await listFiles(name);
    return result;
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

  private async ensureImage(image: string): Promise<void> {
    if (this.imageReady) return;
    if (this.imageBuilding) return this.imageBuilding;

    this.imageBuilding = (async () => {
      if (await docker.imageExists(image)) {
        this.imageReady = true;
        return;
      }

      const registryImage = process.env.REGISTRY_IMAGE;
      if (registryImage) {
        try {
          mgrLog.info("pulling image from registry", { image: registryImage });
          await docker.pullImage(registryImage);
          await docker.tagImage(registryImage, image);
          this.imageReady = true;
          return;
        } catch (err) {
          mgrLog.warn("failed to pull image, will try building", { error: String(err) });
        }
      }

      const buildDir = process.env.IMAGE_BUILD_DIR;
      if (buildDir) {
        mgrLog.info("building image", { dir: buildDir, tag: image });
        await docker.buildImage(image, buildDir);
        this.imageReady = true;
      } else {
        throw new Error(`Image "${image}" not found and no IMAGE_BUILD_DIR configured`);
      }
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
