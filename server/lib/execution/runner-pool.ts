/**
 * RunnerPool — routes execution calls across multiple runner instances.
 * Implements ExecutionBackend so it's a drop-in replacement for RunnerClient.
 *
 * Project-to-runner mapping is ephemeral (in-memory only). When a container
 * is destroyed the mapping is cleared, and the next ensureContainer picks
 * whichever runner has the most capacity.
 */
import type { BrowserAction, BrowserResult } from "@/lib/browser/protocol.ts";
import type {
  ExecutionBackend, BashResult, ExecResult, SessionInfo, ContainerListEntry,
} from "./backend-interface.ts";
import { RunnerClient } from "./runner-client.ts";
import { listEnabledRunners, insertRunner } from "@/db/queries/runners.ts";
import { getSetting } from "@/lib/settings.ts";
import { log } from "@/lib/logger.ts";

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

  async init(): Promise<boolean> {
    let runners = listEnabledRunners();

    // Backward compat: migrate legacy single-runner settings
    if (runners.length === 0) {
      const url = getSetting("RUNNER_URL");
      const key = getSetting("RUNNER_API_KEY") ?? "";
      if (url) {
        insertRunner({ name: "Default", url, apiKey: key });
        runners = listEnabledRunners();
        poolLog.info("migrated legacy RUNNER_URL to runners table");
      }
    }

    if (runners.length === 0) return false;

    for (const r of runners) {
      const client = new RunnerClient(r.url, r.api_key);
      const healthy = await client.init();
      if (healthy) {
        this.clients.set(r.id, client);
        this.runnerNames.set(r.id, r.name);
      } else {
        poolLog.warn("runner not healthy, skipping", { id: r.id, name: r.name, url: r.url });
      }
    }

    this._ready = this.clients.size > 0;
    if (this._ready) {
      poolLog.info("runner pool ready", { healthy: this.clients.size, total: runners.length });
    }
    return this._ready;
  }

  /** Hot-reload runners from DB without tearing down existing connections. */
  async reload(): Promise<void> {
    const runners = listEnabledRunners();
    const newIds = new Set(runners.map(r => r.id));

    // Remove deleted/disabled runners
    for (const id of this.clients.keys()) {
      if (!newIds.has(id)) {
        this.clients.delete(id);
        this.runnerNames.delete(id);
        poolLog.info("removed runner from pool", { id });
      }
    }

    // Add new runners
    for (const r of runners) {
      this.runnerNames.set(r.id, r.name);
      if (!this.clients.has(r.id)) {
        const client = new RunnerClient(r.url, r.api_key);
        const healthy = await client.init();
        if (healthy) {
          this.clients.set(r.id, client);
          poolLog.info("added runner to pool", { id: r.id, name: r.name });
        }
      }
    }

    // Clean stale project mappings pointing to removed runners
    for (const [projectId, runnerId] of this.projectRunner) {
      if (!this.clients.has(runnerId)) {
        this.projectRunner.delete(projectId);
      }
    }

    this._ready = this.clients.size > 0;
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
  }

  async syncProjectFiles(projectId: string, manifest: Record<string, string>): Promise<void> {
    const { client } = await this.getClientForProject(projectId);
    await client.syncProjectFiles(projectId, manifest);
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
