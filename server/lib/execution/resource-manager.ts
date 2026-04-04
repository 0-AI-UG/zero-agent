import { log } from "@/lib/logger.ts";
import { getSetting } from "@/lib/settings.ts";

const rmLog = log.child({ module: "resource-manager" });

const DEFAULT_MAX_RUNNING = 3;
const DEFAULT_PAUSE_TIMEOUT_SECS = 180;
const DEFAULT_DESTROY_TIMEOUT_SECS = 600;

function getMaxRunning(): number {
  const val = getSetting("CONTAINER_MAX_RUNNING");
  return val ? parseInt(val, 10) || DEFAULT_MAX_RUNNING : DEFAULT_MAX_RUNNING;
}

function getPauseTimeout(): number {
  const val = getSetting("CONTAINER_PAUSE_TIMEOUT_SECS");
  const secs = val ? parseInt(val, 10) || DEFAULT_PAUSE_TIMEOUT_SECS : DEFAULT_PAUSE_TIMEOUT_SECS;
  return secs * 1000;
}

function getDestroyTimeout(): number {
  const val = getSetting("CONTAINER_DESTROY_TIMEOUT_SECS");
  const secs = val ? parseInt(val, 10) || DEFAULT_DESTROY_TIMEOUT_SECS : DEFAULT_DESTROY_TIMEOUT_SECS;
  return secs * 1000;
}

export type SessionStatus = "running" | "paused";

export interface SessionEntry {
  sessionId: string;
  userId: string;
  projectId: string;
  containerId: string;
  containerIp: string;
  lastUsedAt: number;
  status: SessionStatus;
  healthFailCount: number;
  busyCount: number;
}

const MAX_HEALTH_FAILURES = 2;

export class ResourceManager {
  private sessions = new Map<string, SessionEntry>();
  private reaper: ReturnType<typeof setInterval>;

  /** Called by LocalBackend to actually pause/unpause/destroy containers. */
  onPause?: (sessionId: string) => Promise<void>;
  onResume?: (sessionId: string) => Promise<void>;
  onDestroy?: (sessionId: string) => Promise<void>;

  /** CDP port for health checks. */
  cdpPort = 9223;

  constructor() {
    this.reaper = setInterval(() => this.reapIdle(), 30_000);
  }

  get runningCount(): number {
    return [...this.sessions.values()].filter((s) => s.status === "running").length;
  }

  register(entry: Omit<SessionEntry, "status" | "healthFailCount" | "busyCount">): void {
    this.sessions.set(entry.sessionId, { ...entry, status: "running", healthFailCount: 0, busyCount: 0 });
    rmLog.info("session registered", { sessionId: entry.sessionId, userId: entry.userId, total: this.sessions.size, running: this.runningCount });
  }

  get(sessionId: string): SessionEntry | undefined {
    const entry = this.sessions.get(sessionId);
    if (entry) entry.lastUsedAt = Date.now();
    return entry;
  }

  remove(sessionId: string): void {
    this.sessions.delete(sessionId);
    rmLog.info("session removed", { sessionId, total: this.sessions.size });
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  getAll(): SessionEntry[] {
    return [...this.sessions.values()];
  }

  markBusy(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry) entry.busyCount++;
  }

  markIdle(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry && entry.busyCount > 0) entry.busyCount--;
  }

  /** Ensure there's a running slot available. Pauses the LRU idle container if needed. */
  async ensureSlot(excludeSessionId?: string): Promise<void> {
    const maxRunning = getMaxRunning();
    const running = [...this.sessions.values()]
      .filter((s) => s.status === "running" && s.sessionId !== excludeSessionId && s.busyCount === 0)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt);

    if (this.runningCount >= maxRunning && running.length === 0) {
      throw new Error("All container slots are busy. Please try again shortly.");
    }

    while (this.runningCount >= maxRunning && running.length > 0) {
      const victim = running.shift()!;
      rmLog.info("pausing container to free slot", { sessionId: victim.sessionId });
      await this.onPause?.(victim.sessionId);
      victim.status = "paused";
    }
  }

  /** Resume a paused session, pausing another if needed to stay within limits. */
  async ensureRunning(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    if (entry.status === "running") return;

    await this.ensureSlot(sessionId);
    rmLog.info("resuming paused container", { sessionId });
    await this.onResume?.(sessionId);
    entry.status = "running";
    entry.lastUsedAt = Date.now();
  }

  canCreate(): { allowed: boolean; reason?: string } {
    // We can always create — we'll pause others to make room.
    // But cap total tracked sessions to prevent unbounded growth.
    if (this.sessions.size >= 20) {
      return { allowed: false, reason: `Server has ${this.sessions.size} tracked sessions (max 20)` };
    }
    return { allowed: true };
  }

  private async reapIdle(): Promise<void> {
    const now = Date.now();
    const destroyTimeout = getDestroyTimeout();
    const pauseTimeout = getPauseTimeout();
    for (const [id, entry] of this.sessions) {
      const idleMs = now - entry.lastUsedAt;
      if (idleMs > destroyTimeout && entry.busyCount === 0) {
        rmLog.info("reaping idle session (destroy)", { sessionId: id, status: entry.status, idleSecs: Math.round(idleMs / 1000) });
        await this.onDestroy?.(id);
        this.sessions.delete(id);
        continue;
      }
      if (idleMs > pauseTimeout && entry.status === "running" && entry.busyCount === 0) {
        rmLog.info("pausing idle session", { sessionId: id, idleSecs: Math.round(idleMs / 1000) });
        await this.onPause?.(id);
        entry.status = "paused";
        continue;
      }
      // Health check running containers
      if (entry.status === "running") {
        const healthy = await this.checkHealth(entry);
        if (healthy) {
          entry.healthFailCount = 0;
        } else {
          entry.healthFailCount++;
          rmLog.warn("health check failed", { sessionId: id, failCount: entry.healthFailCount });
          if (entry.healthFailCount >= MAX_HEALTH_FAILURES) {
            rmLog.error("destroying unhealthy container", { sessionId: id, failCount: entry.healthFailCount });
            await this.onDestroy?.(id);
            this.sessions.delete(id);
          }
        }
      }
    }
  }

  private async checkHealth(entry: SessionEntry): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`http://${entry.containerIp}:${this.cdpPort}/json/version`, { signal: controller.signal });
      clearTimeout(timer);
      return res.ok;
    } catch {
      return false;
    }
  }

  stop(): void {
    clearInterval(this.reaper);
  }
}
