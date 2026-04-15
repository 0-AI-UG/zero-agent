/**
 * RunnerClient - connects to a remote runner service over HTTP.
 * Implements ExecutionBackend so tools don't need to know whether
 * execution is local or remote.
 */
import http from "node:http";
import type { BrowserAction, BrowserResult } from "@/lib/browser/protocol.ts";
import type {
  ExecutionBackend, BashResult, ExecResult, SessionInfo, ContainerListEntry, StreamExecFrame, AuthExecFrame,
} from "./backend-interface.ts";
import { listS3Files, readStreamFromS3, writeStreamToS3, s3FileExists, s3FileSize } from "@/lib/s3.ts";
import { fetchWithTimeout } from "@/lib/utils/deferred.ts";
import { log } from "@/lib/utils/logger.ts";

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
    return fetch(`${this.baseUrl}/api/v1${path}`, {
      ...rest,
      headers: {
        ...Object.fromEntries(new Headers(rest.headers ?? {}).entries()),
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": rest.headers ? (new Headers(rest.headers).get("Content-Type") ?? "application/json") : "application/json",
      },
      signal: AbortSignal.timeout(timeout),
    });
  }

  private async json<T>(path: string, init?: RequestInit & { timeout?: number }): Promise<T> {
    let res: Response;
    try {
      res = await this.request(path, init);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      clientLog.error("runner request failed", { path, method: init?.method ?? "GET", error: message });
      throw new Error(`Runner request failed (${init?.method ?? "GET"} ${path}): ${message}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      clientLog.error("runner API error", { path, status: res.status, body: body.slice(0, 500) });
      throw new Error(`Runner API error ${res.status} (${init?.method ?? "GET"} ${path}): ${body}`);
    }
    const text = await res.text();
    if (!text) {
      clientLog.error("runner returned empty body", { path, status: res.status });
      throw new Error(`Runner returned empty body (${init?.method ?? "GET"} ${path})`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      clientLog.error("runner returned invalid JSON", { path, status: res.status, body: text.slice(0, 500), error: message });
      throw new Error(`Runner returned invalid JSON (${init?.method ?? "GET"} ${path}): ${message}`);
    }
    if (parsed === null || parsed === undefined) {
      clientLog.error("runner returned null JSON", { path, status: res.status });
      throw new Error(`Runner returned null JSON (${init?.method ?? "GET"} ${path})`);
    }
    return parsed as T;
  }

  /**
   * Stream a ReadableStream body to the runner using Node.js http.request.
   * Unlike fetch, this pipes chunks directly without buffering the whole body,
   * keeping memory usage constant regardless of payload size.
   */
  private streamUpload(
    path: string,
    stream: ReadableStream<Uint8Array>,
    size: number,
    timeout: number,
  ): Promise<void> {
    const url = new URL(`${this.baseUrl}/api/v1${path}`);
    return new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port || 80,
          path: url.pathname + url.search,
          method: "PUT",
          headers: {
            "Authorization": `Bearer ${this.apiKey}`,
            "Content-Type": "application/gzip",
            "Content-Length": String(size),
          },
          timeout,
        },
        (res) => {
          // Consume response body to free the socket
          res.resume();
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(new Error(`Stream upload failed: ${res.statusCode}`));
          }
        },
      );

      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy(new Error("Stream upload timed out"));
      });

      // Pipe the ReadableStream through the request in chunks
      const reader = stream.getReader();
      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const ok = req.write(value);
            if (!ok) {
              // Back-pressure: wait for drain before writing more
              await new Promise<void>((r) => req.once("drain", r));
            }
          }
          req.end();
        } catch (err) {
          req.destroy(err instanceof Error ? err : new Error(String(err)));
        }
      })();
    });
  }

  // -- Lifecycle --

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetchWithTimeout(`${this.baseUrl}/health`, { timeout: 5_000 });
      if (!res.ok) {
        clientLog.warn("runner health check returned non-ok status", { url: this.baseUrl, status: res.status });
        return false;
      }
      const data = await res.json() as { dockerReady?: boolean };
      if (data.dockerReady !== true) {
        clientLog.warn("runner health check: docker not ready", { url: this.baseUrl });
        return false;
      }
      return true;
    } catch (err) {
      clientLog.warn("runner health check failed", { url: this.baseUrl, error: String(err) });
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
    const result = await this.json<{ name: string; ip: string; status: string; created?: boolean }>(`/containers`, {
      method: "POST",
      body: JSON.stringify({ name, userId }),
      timeout: 60_000,
    });
    this.sessionCache.set(projectId, {
      info: { sessionId: projectId, containerIp: result.ip, containerName: name, userId },
      expiresAt: Date.now() + RunnerClient.SESSION_CACHE_TTL,
    });

    // Only restore snapshots/blobs when the runner actually created a new
    // container. Previously we used an in-memory `existed` flag that reset on
    // every server restart, causing a 391MB snapshot to be buffered into memory
    // even though the container was already running — triggering OOM on small VPS.
    if (!result.created) return;

    try {
      const snapshotKey = `containers/${projectId}/system.tar.gz`;
      if (s3FileExists(snapshotKey)) {
        const size = s3FileSize(snapshotKey);
        const stream = readStreamFromS3(snapshotKey);
        await this.streamUpload(
          `/containers/${encodeURIComponent(name)}/files/snapshot`,
          stream,
          size,
          120_000,
        );
        const pm = process.memoryUsage();
        clientLog.info("system snapshot restored from S3 (streamed)", { projectId, sizeBytes: size, heapMB: (pm.heapUsed / 1048576).toFixed(0), extMB: (pm.external / 1048576).toFixed(0), arrMB: (pm.arrayBuffers / 1048576).toFixed(0) });
      }
    } catch {
      // First-time projects have no snapshot - silently skip.
    }

    // Restore workspace blob dirs sequentially to avoid parallel memory spikes
    try {
      const prefix = `projects/${projectId}/.session/blobs/`;
      const keys = await listS3Files(prefix);
      for (const key of keys) {
        try {
          const filename = key.slice(prefix.length);
          const dir = filename.replace(/\.tar\.gz$/, "").replace(/__/g, "/");
          if (!dir) continue;
          if (!s3FileExists(key)) continue;
          const size = s3FileSize(key);
          if (size === 0) continue;
          const stream = readStreamFromS3(key);
          await this.streamUpload(
            `/containers/${encodeURIComponent(name)}/files/blob?dir=${encodeURIComponent(dir)}`,
            stream,
            size,
            180_000,
          );
          clientLog.info("blob dir restored (streamed)", { projectId, dir, sizeBytes: size });
        } catch (err) {
          clientLog.warn("blob restore failed", { projectId, key, error: String(err) });
        }
      }
    } catch {
      // No blob dirs in S3 yet - fine.
    }
  }

  // -- Blob dir methods --

  async listBlobDirs(projectId: string): Promise<string[]> {
    const name = this.containerName(projectId);
    try {
      const result = await this.json<{ dirs: string[] }>(`/containers/${encodeURIComponent(name)}/files/blob-dirs`, {
        timeout: 30_000,
      });
      return result.dirs ?? [];
    } catch (err) {
      clientLog.warn("listBlobDirs failed", { projectId, error: String(err) });
      return [];
    }
  }

  async saveBlobDir(projectId: string, dir: string): Promise<ReadableStream<Uint8Array> | null> {
    const name = this.containerName(projectId);
    try {
      const res = await this.request(
        `/containers/${encodeURIComponent(name)}/files/blob?dir=${encodeURIComponent(dir)}`,
        { method: "POST", timeout: 180_000, headers: { "Content-Type": "application/json" } },
      );
      if (!res.ok || !res.body) return null;
      // Check Content-Length to avoid returning empty streams
      const cl = res.headers.get("Content-Length");
      if (cl === "0") return null;
      return res.body as ReadableStream<Uint8Array>;
    } catch (err) {
      clientLog.warn("saveBlobDir failed", { projectId, dir, error: String(err) });
      return null;
    }
  }

  async restoreBlobDir(projectId: string, dir: string, data: ReadableStream<Uint8Array>, size?: number): Promise<void> {
    const name = this.containerName(projectId);
    await this.streamUpload(
      `/containers/${encodeURIComponent(name)}/files/blob?dir=${encodeURIComponent(dir)}`,
      data,
      size ?? 0,
      180_000,
    );
  }

  /** Internal helper: stream from S3 → runner for blob restore */
  private async restoreBlobDirStream(projectId: string, dir: string, stream: ReadableStream<Uint8Array>, size: number): Promise<void> {
    return this.restoreBlobDir(projectId, dir, stream, size);
  }

  /** Save a system snapshot to S3. Best-effort, never throws. Streams directly without buffering. */
  async persistSystemSnapshot(projectId: string): Promise<void> {
    const name = this.containerName(projectId);
    try {
      const res = await this.request(`/containers/${encodeURIComponent(name)}/files/snapshot`, {
        method: "POST",
        timeout: 120_000,
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok || !res.body) return;
      const cl = res.headers.get("Content-Length");
      if (cl === "0") return;
      await writeStreamToS3(`containers/${projectId}/system.tar.gz`, res.body as ReadableStream<Uint8Array>);
      clientLog.info("system snapshot persisted (streamed)", { projectId, contentLength: cl });
    } catch (err) {
      clientLog.warn("persistSystemSnapshot failed", { projectId, error: String(err) });
    }
  }

  async destroyContainer(projectId: string): Promise<void> {
    const name = this.containerName(projectId);

    // Save system snapshot before destroying (streamed)
    try {
      const snapshotRes = await this.request(`/containers/${encodeURIComponent(name)}/files/snapshot`, {
        method: "POST",
        timeout: 120_000,
        headers: { "Content-Type": "application/json" },
      });
      if (snapshotRes.ok && snapshotRes.body) {
        const cl = snapshotRes.headers.get("Content-Length");
        if (cl !== "0") {
          await writeStreamToS3(`containers/${projectId}/system.tar.gz`, snapshotRes.body as ReadableStream<Uint8Array>);
          clientLog.info("system snapshot saved to S3 (streamed)", { projectId, contentLength: cl });
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

  async pushFile(projectId: string, relativePath: string, buffer: Buffer): Promise<void> {
    const name = this.containerName(projectId);
    await this.json(`/containers/${encodeURIComponent(name)}/files/write`, {
      method: "POST",
      body: JSON.stringify({ files: [{ path: relativePath, data: buffer.toString("base64") }] }),
      timeout: 30_000,
    });
  }

  async deleteFile(projectId: string, relativePath: string): Promise<void> {
    const name = this.containerName(projectId);
    await this.json(`/containers/${encodeURIComponent(name)}/files/delete`, {
      method: "POST",
      body: JSON.stringify({ paths: [relativePath] }),
      timeout: 30_000,
    });
  }

  async getContainerManifest(projectId: string, subpath = "/project"): Promise<Record<string, string>> {
    const name = this.containerName(projectId);
    const res = await this.json<{ files: Record<string, string> }>(
      `/containers/${encodeURIComponent(name)}/files/manifest?dir=${encodeURIComponent(subpath)}`,
      { timeout: 120_000 },
    );
    return res.files ?? {};
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

    clientLog.debug("runBash request", { name, commandLength: command.length, effectiveTimeout });
    const result = await this.json<{ stdout: string; stderr: string; exitCode: number }>(`/containers/${encodeURIComponent(name)}/bash`, {
      method: "POST",
      body: JSON.stringify({ command, timeout: effectiveTimeout }),
      timeout: httpTimeout,
    });

    if (!result || typeof result !== "object") {
      clientLog.error("runBash: runner returned non-object", { name, result });
      throw new Error(`Runner /bash returned invalid payload: ${JSON.stringify(result)}`);
    }
    const rawStdout = typeof result.stdout === "string" ? result.stdout : "";
    const rawStderr = typeof result.stderr === "string" ? result.stderr : "";
    if (typeof result.stdout !== "string" || typeof result.stderr !== "string" || typeof result.exitCode !== "number") {
      clientLog.warn("runBash: runner payload missing fields", {
        name,
        hasStdout: typeof result.stdout,
        hasStderr: typeof result.stderr,
        hasExitCode: typeof result.exitCode,
      });
    }
    clientLog.debug("runBash response", { name, exitCode: result.exitCode, stdoutLen: rawStdout.length, stderrLen: rawStderr.length });

    // Strip workspace paths
    const stdout = rawStdout.replaceAll("/project/", "").replaceAll("/project", ".");
    const stderr = rawStderr.replaceAll("/project/", "").replaceAll("/project", ".");

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
      exitCode: typeof result.exitCode === "number" ? result.exitCode : -1,
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

  /**
   * Stream a long-running command's output as newline-delimited JSON frames.
   * Connects to the runner's `/exec-stream` endpoint and yields parsed frames
   * until the terminal `{type:"exit"}` frame arrives (or the caller aborts).
   */
  async *streamExecInContainer(
    projectId: string,
    cmd: string[],
    opts?: { workingDir?: string; abortSignal?: AbortSignal },
  ): AsyncIterable<StreamExecFrame> {
    const name = this.containerName(projectId);
    const controller = new AbortController();
    opts?.abortSignal?.addEventListener("abort", () => controller.abort());

    const res = await fetch(`${this.baseUrl}/api/v1/containers/${encodeURIComponent(name)}/exec-stream`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ cmd, workingDir: opts?.workingDir }),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new Error(`Runner exec-stream failed ${res.status}: ${text}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let newline: number;
        while ((newline = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, newline);
          buf = buf.slice(newline + 1);
          if (!line) continue;
          try {
            yield JSON.parse(line) as StreamExecFrame;
          } catch (err) {
            clientLog.warn("exec-stream parse error", { line: line.slice(0, 200), error: String(err) });
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  // -- Auth exec (interactive CLI login sessions) --

  async startAuthExec(
    projectId: string,
    cmd: string[],
    opts?: { workingDir?: string; env?: string[] },
  ): Promise<{ sessionId: string }> {
    const name = this.containerName(projectId);
    return this.json<{ sessionId: string }>(
      `/containers/${encodeURIComponent(name)}/auth-exec/start`,
      {
        method: "POST",
        body: JSON.stringify({ cmd, workingDir: opts?.workingDir, env: opts?.env }),
        timeout: 30_000,
      },
    );
  }

  async *streamAuthExec(
    _projectId: string,
    sessionId: string,
    opts?: { abortSignal?: AbortSignal },
  ): AsyncIterable<AuthExecFrame> {
    const controller = new AbortController();
    opts?.abortSignal?.addEventListener("abort", () => controller.abort());
    const res = await fetch(
      `${this.baseUrl}/api/v1/auth-exec/${encodeURIComponent(sessionId)}/stream`,
      {
        method: "GET",
        headers: { "Authorization": `Bearer ${this.apiKey}` },
        signal: controller.signal,
      },
    );
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new Error(`Runner auth-exec stream failed ${res.status}: ${text}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let newline: number;
        while ((newline = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, newline);
          buf = buf.slice(newline + 1);
          if (!line) continue;
          try {
            yield JSON.parse(line) as AuthExecFrame;
          } catch (err) {
            clientLog.warn("auth-exec parse error", { line: line.slice(0, 200), error: String(err) });
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async writeAuthExecStdin(_projectId: string, sessionId: string, data: string): Promise<void> {
    await this.json(
      `/auth-exec/${encodeURIComponent(sessionId)}/stdin`,
      { method: "POST", body: JSON.stringify({ data }), timeout: 10_000 },
    );
  }

  async cancelAuthExec(_projectId: string, sessionId: string): Promise<void> {
    await this.request(
      `/auth-exec/${encodeURIComponent(sessionId)}`,
      { method: "DELETE", timeout: 10_000 },
    ).catch(() => {});
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
    // Synchronous - return empty. Use async version if needed.
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

  getProxyInfo(projectId: string, port: number, path: string): { url: string; apiKey: string } {
    return { url: this.getProxyUrl(projectId, port, path), apiKey: this.apiKey };
  }
}
