/**
 * RunnerPool - routes execution calls across multiple runner instances.
 * Implements ExecutionBackend so it's a drop-in replacement for RunnerClient.
 *
 * Project-to-runner mapping is ephemeral (in-memory only). When a container
 * is destroyed the mapping is cleared, and the next ensureContainer picks
 * whichever runner has the most capacity.
 */
import type { BrowserAction, BrowserResult } from "@/lib/browser/protocol.ts";
import type {
  ExecutionBackend, BashResult, ExecResult, SessionInfo, ContainerListEntry, WatcherEvent,
} from "./backend-interface.ts";
import { RunnerClient } from "./runner-client.ts";
import { clearProjectActivity } from "./snapshot.ts";
import { listEnabledRunners } from "@/db/queries/runners.ts";
import { log } from "@/lib/utils/logger.ts";

const poolLog = log.child({ module: "runner-pool" });

interface ResolvedRunner {
  runnerId: string;
  client: RunnerClient;
}

export class RunnerPool implements ExecutionBackend {
  private clients = new Map<string, RunnerClient>();
  private runnerNames = new Map<string, string>();
  /** Ephemeral cache: projectId → runnerId. Only valid while container is alive. */
  private projectRunner = new Map<string, string>();
  private _ready = false;

  /**
   * Single source of truth for pool membership. Reads enabled runners from DB,
   * re-health-checks every one, and converges the client map:
   *   - removes runners no longer in DB / no longer healthy
   *   - adds runners now in DB / newly healthy
   */
  async sync(): Promise<{ healthy: number; total: number }> {
    const runners = listEnabledRunners();
    const dbIds = new Set(runners.map(r => r.id));

    // Drop runners no longer in DB
    for (const id of [...this.clients.keys()]) {
      if (!dbIds.has(id)) {
        this.clients.delete(id);
        this.runnerNames.delete(id);
        poolLog.info("removed runner from pool", { id });
      }
    }

    // Health-check every DB runner; add healthy, drop unhealthy
    for (const r of runners) {
      this.runnerNames.set(r.id, r.name);
      const existing = this.clients.get(r.id);
      const client = existing ?? new RunnerClient(r.url, r.api_key);
      const healthy = await client.healthCheck().catch(() => false);

      if (healthy) {
        if (!existing) {
          await client.init().catch(() => {});
          this.clients.set(r.id, client);
          poolLog.info("added runner to pool", { id: r.id, name: r.name });
        }
      } else if (existing) {
        this.clients.delete(r.id);
        poolLog.warn("runner unhealthy, removed from pool", { id: r.id, name: r.name });
      }
    }

    // Clean stale project mappings pointing to removed runners
    for (const [projectId, runnerId] of this.projectRunner) {
      if (!this.clients.has(runnerId)) {
        this.projectRunner.delete(projectId);
      }
    }

    this._ready = this.clients.size > 0;
    return { healthy: this.clients.size, total: runners.length };
  }

  size(): number {
    return this.clients.size;
  }

  hasRunner(runnerId: string): boolean {
    return this.clients.has(runnerId);
  }

  isReady(): boolean {
    return this._ready;
  }

  // ── Routing ──

  /** Find which runner currently hosts a project's container. */
  private async resolveRunner(projectId: string): Promise<ResolvedRunner | null> {
    // Check cache first
    const cached = this.projectRunner.get(projectId);
    if (cached) {
      const client = this.clients.get(cached);
      if (client) return { runnerId: cached, client };
      this.projectRunner.delete(projectId);
    }

    // Probe all runners
    for (const [runnerId, client] of this.clients) {
      try {
        if (await client.hasContainer(projectId)) {
          this.projectRunner.set(projectId, runnerId);
          return { runnerId, client };
        }
      } catch {
        // Runner unreachable, skip
      }
    }

    return null;
  }

  /** Pick the least-loaded runner for a new container. */
  private async pickRunner(): Promise<ResolvedRunner | null> {
    if (this.clients.size === 0) return null;
    if (this.clients.size === 1) {
      const [runnerId, client] = this.clients.entries().next().value!;
      return { runnerId, client };
    }

    // Count containers on each runner
    let best: ResolvedRunner | null = null;
    let bestCount = Infinity;

    for (const [runnerId, client] of this.clients) {
      try {
        const containers = await client.listContainersAsync();
        if (containers.length < bestCount) {
          bestCount = containers.length;
          best = { runnerId, client };
        }
      } catch {
        // Skip unhealthy runner
      }
    }

    return best;
  }

  /** Resolve existing container or throw if not found. */
  private async getClientForProject(projectId: string): Promise<ResolvedRunner> {
    const resolved = await this.resolveRunner(projectId);
    if (resolved) return resolved;
    throw new Error(`No runner found hosting project ${projectId}`);
  }

  // ── ExecutionBackend implementation ──

  async ensureContainer(userId: string, projectId: string): Promise<void> {
    // Check if already running somewhere
    let resolved = await this.resolveRunner(projectId);
    if (resolved) {
      await resolved.client.ensureContainer(userId, projectId);
      return;
    }

    // Pick a runner for new container
    resolved = await this.pickRunner();
    if (!resolved) throw new Error("No healthy runners available");

    await resolved.client.ensureContainer(userId, projectId);
    this.projectRunner.set(projectId, resolved.runnerId);
  }

  async destroyContainer(projectId: string): Promise<void> {
    const resolved = await this.resolveRunner(projectId);
    if (!resolved) return; // already gone
    await resolved.client.destroyContainer(projectId);
    this.projectRunner.delete(projectId);
    clearProjectActivity(projectId);
  }

  async getContainerManifest(projectId: string, subpath?: string): Promise<Record<string, string>> {
    const { client } = await this.getClientForProject(projectId);
    return client.getContainerManifest(projectId, subpath);
  }

  async pushFile(projectId: string, relativePath: string, buffer: Buffer): Promise<void> {
    const { client } = await this.getClientForProject(projectId);
    await client.pushFile(projectId, relativePath, buffer);
  }

  async deleteFile(projectId: string, relativePath: string): Promise<void> {
    const { client } = await this.getClientForProject(projectId);
    await client.deleteFile(projectId, relativePath);
  }

  async listBlobDirs(projectId: string): Promise<string[]> {
    const resolved = await this.resolveRunner(projectId);
    if (!resolved) return [];
    return resolved.client.listBlobDirs(projectId);
  }

  async saveBlobDir(projectId: string, dir: string): Promise<ReadableStream<Uint8Array> | null> {
    const resolved = await this.resolveRunner(projectId);
    if (!resolved) return null;
    return resolved.client.saveBlobDir(projectId, dir);
  }

  async restoreBlobDir(projectId: string, dir: string, data: ReadableStream<Uint8Array>, size?: number): Promise<void> {
    const resolved = await this.resolveRunner(projectId);
    if (!resolved) return;
    return resolved.client.restoreBlobDir(projectId, dir, data, size);
  }

  async persistSystemSnapshot(projectId: string): Promise<void> {
    const resolved = await this.resolveRunner(projectId);
    if (!resolved) return;
    await resolved.client.persistSystemSnapshot(projectId);
  }

  touchActivity(projectId: string): void {
    const cached = this.projectRunner.get(projectId);
    if (cached) {
      const client = this.clients.get(cached);
      if (client) client.touchActivity(projectId);
    }
  }

  async runBash(userId: string, projectId: string, command: string, timeout?: number, background?: boolean): Promise<BashResult> {
    const { client } = await this.getClientForProject(projectId);
    return client.runBash(userId, projectId, command, timeout, background);
  }

  async execute(userId: string, projectId: string, action: BrowserAction, stealth?: boolean): Promise<BrowserResult> {
    const { client } = await this.getClientForProject(projectId);
    return client.execute(userId, projectId, action, stealth);
  }

  async getLatestScreenshot(projectId: string): Promise<{ base64: string; title: string; url: string; timestamp: number } | null> {
    const resolved = await this.resolveRunner(projectId);
    if (!resolved) return null;
    return resolved.client.getLatestScreenshot(projectId);
  }

  async streamWatcherEvents(projectId: string, onEvent: (event: WatcherEvent) => void, signal: AbortSignal): Promise<void> {
    const { client } = await this.getClientForProject(projectId);
    return client.streamWatcherEvents(projectId, onEvent, signal);
  }

  async flushWatcher(projectId: string): Promise<void> {
    const resolved = await this.resolveRunner(projectId);
    if (!resolved) return;
    return resolved.client.flushWatcher(projectId);
  }

  async execInContainer(projectId: string, cmd: string[], opts?: { timeout?: number; workingDir?: string }): Promise<ExecResult> {
    const { client } = await this.getClientForProject(projectId);
    return client.execInContainer(projectId, cmd, opts);
  }

  async checkPort(projectId: string, port: number): Promise<boolean> {
    const resolved = await this.resolveRunner(projectId);
    if (!resolved) return false;
    return resolved.client.checkPort(projectId, port);
  }

  getProxyInfo(projectId: string, port: number, path: string): { url: string; apiKey: string } {
    const cached = this.projectRunner.get(projectId);
    if (cached) {
      const client = this.clients.get(cached);
      if (client) return client.getProxyInfo(projectId, port, path);
    }
    // Fallback: use first available runner (caller should have ensured container first)
    const first = this.clients.values().next().value;
    if (first) return first.getProxyInfo(projectId, port, path);
    throw new Error("No runners available");
  }

  getSessionForProject(projectId: string): SessionInfo | null {
    const cached = this.projectRunner.get(projectId);
    if (cached) {
      const client = this.clients.get(cached);
      if (client) return client.getSessionForProject(projectId);
    }
    return null;
  }

  async hasContainer(projectId: string): Promise<boolean> {
    const resolved = await this.resolveRunner(projectId);
    return resolved !== null;
  }

  async ensureSessionForProject(projectId: string, userId: string): Promise<SessionInfo> {
    await this.ensureContainer(userId, projectId);
    const cached = this.projectRunner.get(projectId);
    const client = this.clients.get(cached!);
    return client!.getSessionForProject(projectId)!;
  }

  listContainers(): ContainerListEntry[] {
    return [];
  }

  async listContainersAsync(): Promise<ContainerListEntry[]> {
    const results: ContainerListEntry[] = [];
    for (const [runnerId, client] of this.clients) {
      try {
        const containers = await client.listContainersAsync();
        const name = this.runnerNames.get(runnerId);
        for (const c of containers) {
          results.push({ ...c, runnerName: name });
        }
      } catch {
        // Skip unreachable runner
      }
    }
    return results;
  }

  async destroyAll(): Promise<void> {
    for (const [, client] of this.clients) {
      try {
        await client.destroyAll();
      } catch (err) {
        poolLog.warn("failed to destroy containers on runner", { error: String(err) });
      }
    }
    this.projectRunner.clear();
  }
}
