/**
 * RunnerClient — connects to a remote runner service over HTTP.
 * Implements ExecutionBackend so tools don't need to know whether
 * execution is local or remote.
 */
import type { BrowserAction, BrowserResult } from "@/lib/browser/protocol.ts";
import type {
  ExecutionBackend, BashResult, ExecResult, SessionInfo, ContainerListEntry,
} from "./backend-interface.ts";
import { readBinaryFromS3, writeToS3 } from "@/lib/s3.ts";
import { fetchWithTimeout, deferAsync } from "@/lib/deferred.ts";
import { log } from "@/lib/logger.ts";

const clientLog = log.child({ module: "runner-client" });

export class RunnerClient implements ExecutionBackend {
  private baseUrl: string;
  private apiKey: string;
  private _ready = false;

  // Cache session info to avoid repeated HTTP calls
  private sessionCache = new Map<string, { info: SessionInfo; expiresAt: number }>();
  private static SESSION_CACHE_TTL = 60_000;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
  }

  private async request(path: string, init?: RequestInit & { timeout?: number }): Promise<Response> {
    const { timeout = 30_000, ...rest } = init ?? {};
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await deferAsync(() =>
        fetch(`${this.baseUrl}/api/v1${path}`, {
          ...rest,
          signal: controller.signal,
          headers: {
            ...Object.fromEntries(new Headers(rest.headers ?? {}).entries()),
            "Authorization": `Bearer ${this.apiKey}`,
            "Content-Type": rest.headers ? (new Headers(rest.headers).get("Content-Type") ?? "application/json") : "application/json",
          },
        }),
      );
      return res;
    } finally {
      clearTimeout(timer);
    }
  }

  private async json<T>(path: string, init?: RequestInit & { timeout?: number }): Promise<T> {
    const res = await this.request(path, init);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Runner API error ${res.status}: ${body}`);
    }
    return res.json() as Promise<T>;
  }

  // -- Lifecycle --

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetchWithTimeout(`${this.baseUrl}/health`, { timeout: 5_000 });
      if (!res.ok) return false;
      const data = await res.json() as { dockerReady?: boolean };
      return data.dockerReady === true;
    } catch {
      return false;
    }
  }

  async init(): Promise<boolean> {
    const ready = await this.healthCheck();
    this._ready = ready;
    if (ready) clientLog.info("connected to runner", { url: this.baseUrl });
    else clientLog.warn("runner not healthy", { url: this.baseUrl });
    return ready;
  }

  isReady(): boolean {
    return this._ready;
  }

  // -- Container lifecycle --

  private containerName(projectId: string): string {
    return `session-${projectId}`;
  }

  async ensureContainer(userId: string, projectId: string): Promise<void> {
    const name = this.containerName(projectId);
    const result = await this.json<{ name: string; ip: string; status: string }>(`/containers`, {
      method: "POST",
      body: JSON.stringify({ name }),
      timeout: 60_000,
    });
    this.sessionCache.set(projectId, {
      info: { sessionId: projectId, containerIp: result.ip, containerName: name },
      expiresAt: Date.now() + RunnerClient.SESSION_CACHE_TTL,
    });
  }

  async destroyContainer(projectId: string): Promise<void> {
    const name = this.containerName(projectId);

    // Save system snapshot before destroying
    try {
      const snapshotRes = await this.request(`/containers/${encodeURIComponent(name)}/files/snapshot`, {
        method: "POST",
        timeout: 120_000,
        headers: { "Content-Type": "application/json" },
      });
      if (snapshotRes.ok) {
        const buffer = Buffer.from(await snapshotRes.arrayBuffer());
        if (buffer.byteLength > 0) {
          await writeToS3(`containers/${projectId}/system.tar.gz`, buffer);
          clientLog.info("system snapshot saved to S3", { projectId, sizeBytes: buffer.byteLength });
        }
      }
    } catch (err) {
      clientLog.warn("failed to save snapshot before destroy", { projectId, error: String(err) });
    }

    await this.json(`/containers/${encodeURIComponent(name)}`, {
      method: "DELETE",
      timeout: 30_000,
    });

    this.sessionCache.delete(projectId);
  }

  async syncProjectFiles(projectId: string, manifest: Record<string, string>): Promise<void> {
    const name = this.containerName(projectId);

    // Download files from S3 and write them to the container
    const entries = Object.entries(manifest);
    if (entries.length === 0) return;

    // Download in batches of 10
    const BATCH_SIZE = 10;
    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
      const batch = entries.slice(i, i + BATCH_SIZE);
      const files = await Promise.all(batch.map(async ([relativePath, _url]) => {
        const s3Key = `projects/${projectId}/${relativePath}`;
        const { readBinaryFromS3: readS3 } = await import("@/lib/s3.ts");
        const buffer = await readS3(s3Key);
        return { path: relativePath, data: buffer.toString("base64") };
      }));

      await this.json(`/containers/${encodeURIComponent(name)}/files/write`, {
        method: "POST",
        body: JSON.stringify({ files }),
        timeout: 60_000,
      });
    }
  }

  touchActivity(projectId: string): void {
    const name = this.containerName(projectId);
    // Fire and forget
    this.request(`/containers/${encodeURIComponent(name)}/touch`, { method: "POST" }).catch(() => {});
  }

  // -- Code execution --

  async runBash(userId: string, projectId: string, command: string, timeout?: number, background?: boolean): Promise<BashResult> {
    const name = this.containerName(projectId);

    if (background) {
      const bgCommand = `nohup bash -c '${command.replace(/'/g, "'\\''")}' > /dev/null 2>&1 & echo $!`;
      const result = await this.json<{ stdout: string; stderr: string; exitCode: number }>(`/containers/${encodeURIComponent(name)}/exec`, {
        method: "POST",
        body: JSON.stringify({ cmd: ["bash", "-c", bgCommand], timeout: 15_000 }),
        timeout: 20_000,
      });
      const pid = result.stdout.trim();
      return {
        stdout: pid ? `Process started in background (PID: ${pid})` : result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
    }

    // Touch change marker, run command, detect changes, read changed files
    // The runner's bash endpoint handles marker + truncation but not change detection.
    // We do change detection via separate calls.

    // Touch marker + get pre-file-list
    await this.json(`/containers/${encodeURIComponent(name)}/files/write`, {
      method: "POST",
      body: JSON.stringify({ files: [] }), // no-op write to ensure container is alive
      timeout: 10_000,
    });

    // Use the exec endpoint to touch marker
    await this.json(`/containers/${encodeURIComponent(name)}/exec`, {
      method: "POST",
      body: JSON.stringify({ cmd: ["bash", "-c", "touch /tmp/.snapshot-marker"], workingDir: "/" }),
      timeout: 10_000,
    });

    const effectiveTimeout = timeout ?? 120_000;
    const httpTimeout = effectiveTimeout + 30_000;

    const result = await this.json<{ stdout: string; stderr: string; exitCode: number }>(`/containers/${encodeURIComponent(name)}/bash`, {
      method: "POST",
      body: JSON.stringify({ command, timeout: effectiveTimeout }),
      timeout: httpTimeout,
    });

    // Strip workspace paths
    const stdout = result.stdout.replaceAll("/workspace/", "").replaceAll("/workspace", ".");
    const stderr = result.stderr.replaceAll("/workspace/", "").replaceAll("/workspace", ".");

    // Detect changes
    const changes = await this.json<{ changed: string[]; deleted: string[] }>(`/containers/${encodeURIComponent(name)}/files/changes`, {
      method: "POST",
      timeout: 30_000,
    });

    // Read changed files
    let changedFiles: BashResult["changedFiles"];
    if (changes.changed.length > 0) {
      const readResult = await this.json<{ files: Array<{ path: string; data: string; sizeBytes: number }> }>(`/containers/${encodeURIComponent(name)}/files/read`, {
        method: "POST",
        body: JSON.stringify({ paths: changes.changed }),
        timeout: 60_000,
      });
      changedFiles = readResult.files;
    }

    return {
      stdout,
      stderr,
      exitCode: result.exitCode,
      ...(changedFiles && changedFiles.length > 0 ? { changedFiles } : {}),
      ...(changes.deleted.length > 0 ? { deletedFiles: changes.deleted } : {}),
    };
  }

  // -- Browser --

  async execute(userId: string, projectId: string, action: BrowserAction, stealth?: boolean): Promise<BrowserResult> {
    const name = this.containerName(projectId);
    return this.json<BrowserResult>(`/containers/${encodeURIComponent(name)}/browser`, {
      method: "POST",
      body: JSON.stringify({ action, stealth }),
      timeout: 60_000,
    });
  }

  async getLatestScreenshot(projectId: string): Promise<{ base64: string; title: string; url: string; timestamp: number } | null> {
    const name = this.containerName(projectId);
    try {
      const res = await this.request(`/containers/${encodeURIComponent(name)}/browser/screenshot`);
      if (!res.ok) return null;
      return await res.json() as { base64: string; title: string; url: string; timestamp: number };
    } catch {
      return null;
    }
  }

  // -- Raw exec --

  async execInContainer(projectId: string, cmd: string[], opts?: { timeout?: number; workingDir?: string }): Promise<ExecResult> {
    const name = this.containerName(projectId);
    return this.json<ExecResult>(`/containers/${encodeURIComponent(name)}/exec`, {
      method: "POST",
      body: JSON.stringify({ cmd, timeout: opts?.timeout, workingDir: opts?.workingDir }),
      timeout: (opts?.timeout ?? 120_000) + 10_000,
    });
  }

  // -- Port checks --

  async checkPort(projectId: string, port: number): Promise<boolean> {
    const name = this.containerName(projectId);
    try {
      const res = await fetchWithTimeout(`${this.baseUrl}/proxy/${encodeURIComponent(name)}/${port}/`, {
        method: "HEAD",
        redirect: "manual",
        timeout: 3_000,
        headers: { "Authorization": `Bearer ${this.apiKey}` },
      });
      // Any response (even 4xx/5xx) from the app means the port is listening.
      // 502 means the runner couldn't reach the container port.
      return res.status !== 502;
    } catch {
      return false;
    }
  }

  // -- Session info --

  getSessionForProject(projectId: string): SessionInfo | null {
    const cached = this.sessionCache.get(projectId);
    if (cached && Date.now() < cached.expiresAt) return cached.info;
    this.sessionCache.delete(projectId);
    return null;
  }

  async hasContainer(projectId: string): Promise<boolean> {
    const name = this.containerName(projectId);
    try {
      const res = await this.request(`/containers/${encodeURIComponent(name)}`);
      return res.ok;
    } catch {
      return false;
    }
  }

  async ensureSessionForProject(projectId: string, userId: string): Promise<SessionInfo> {
    await this.ensureContainer(userId, projectId);
    // ensureContainer already populated the cache
    return this.sessionCache.get(projectId)!.info;
  }

  listContainers(): ContainerListEntry[] {
    // Synchronous — return empty. Use async version if needed.
    return [];
  }

  async listContainersAsync(): Promise<ContainerListEntry[]> {
    const result = await this.json<{ containers: Array<{ name: string; ip: string; status: string; createdAt: number; lastUsedAt: number }> }>("/containers");
    return result.containers.map(c => ({
      sessionId: c.name.replace(/^session-/, ""),
      userId: "",
      projectId: c.name.replace(/^session-/, ""),
      status: c.status,
      lastUsedAt: c.lastUsedAt,
    }));
  }

  async destroyAll(): Promise<void> {
    // Save snapshots for all containers first
    try {
      const containers = await this.listContainersAsync();
      for (const c of containers) {
        try {
          await this.destroyContainer(c.projectId);
        } catch (err) {
          clientLog.warn("failed to destroy container during destroyAll", { projectId: c.projectId, error: String(err) });
        }
      }
    } catch {
      // If listing fails, just destroy all without snapshots
      await this.json("/containers", { method: "DELETE", timeout: 60_000 });
    }
    this.sessionCache.clear();
  }

  // -- Proxy helper for app-proxy --

  getProxyUrl(projectId: string, port: number, path: string): string {
    const name = this.containerName(projectId);
    return `${this.baseUrl}/proxy/${encodeURIComponent(name)}/${port}/${path}`;
  }
}
