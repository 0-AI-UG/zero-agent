/**
 * Docker Engine API client — communicates with Docker via Unix socket.
 */
import http from "node:http";
import { log } from "./logger.ts";

const dockerLog = log.child({ module: "docker-client" });

const API_VERSION = "v1.47";

/** fetch-like wrapper for Unix socket HTTP requests (buffered response) */
function unixFetch(url: string, socketPath: string, init?: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options: http.RequestOptions = {
      socketPath,
      path: parsed.pathname + parsed.search,
      method: init?.method ?? "GET",
      headers: init?.headers as Record<string, string> | undefined,
    };

    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks);
        const headers = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (value) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
        }
        resolve(new Response(body, {
          status: res.statusCode ?? 200,
          statusText: res.statusMessage,
          headers,
        }));
      });
      res.on("error", reject);
    });

    req.on("error", reject);

    if (init?.body) {
      if (init.body instanceof ArrayBuffer || init.body instanceof Uint8Array || Buffer.isBuffer(init.body)) {
        req.write(Buffer.from(init.body as ArrayBuffer));
      } else if (typeof init.body === "string") {
        req.write(init.body);
      }
    }
    req.end();
  });
}

/** Streaming variant — resolves as soon as headers arrive, body is a ReadableStream */
function unixFetchStreaming(url: string, socketPath: string, init?: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options: http.RequestOptions = {
      socketPath,
      path: parsed.pathname + parsed.search,
      method: init?.method ?? "GET",
      headers: init?.headers as Record<string, string> | undefined,
    };

    const req = http.request(options, (res) => {
      const headers = new Headers();
      for (const [key, value] of Object.entries(res.headers)) {
        if (value) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      }

      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          res.on("data", (chunk: Buffer) => {
            controller.enqueue(new Uint8Array(chunk));
          });
          res.on("end", () => controller.close());
          res.on("error", (err) => controller.error(err));
        },
        cancel() {
          res.destroy();
        },
      });

      resolve(new Response(body, {
        status: res.statusCode ?? 200,
        statusText: res.statusMessage,
        headers,
      }));
    });

    req.on("error", reject);

    if (init?.body) {
      if (init.body instanceof ArrayBuffer || init.body instanceof Uint8Array || Buffer.isBuffer(init.body)) {
        req.write(Buffer.from(init.body as ArrayBuffer));
      } else if (typeof init.body === "string") {
        req.write(init.body);
      }
    }
    req.end();
  });
}

/** Streaming PUT — pipes a ReadableStream as the request body */
function unixFetchStreamingPut(
  url: string,
  socketPath: string,
  stream: ReadableStream<Uint8Array>,
  headers?: Record<string, string>,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options: http.RequestOptions = {
      socketPath,
      path: parsed.pathname + parsed.search,
      method: "PUT",
      headers,
    };

    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks);
        const resHeaders = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (value) resHeaders.set(key, Array.isArray(value) ? value.join(", ") : value);
        }
        resolve(new Response(body, {
          status: res.statusCode ?? 200,
          statusText: res.statusMessage,
          headers: resHeaders,
        }));
      });
      res.on("error", reject);
    });

    req.on("error", reject);

    // Pipe the ReadableStream into the http request
    const reader = stream.getReader();
    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          // Apply backpressure: wait for drain if write returns false
          const canWrite = req.write(value);
          if (!canWrite) {
            await new Promise<void>((r) => req.once("drain", r));
          }
        }
        req.end();
      } catch (err) {
        req.destroy(err instanceof Error ? err : new Error(String(err)));
      } finally {
        reader.releaseLock();
      }
    })();
  });
}

// -- Types --

/**
 * Docker `Mount` spec (modern HostConfig.Mounts entry). Supports named
 * volumes with VolumeOptions.Subpath, which we use to give each session
 * container its own subdirectory inside the shared runner socket volume.
 */
export interface DockerMount {
  Type: "volume" | "bind" | "tmpfs";
  Source: string;
  Target: string;
  ReadOnly?: boolean;
  VolumeOptions?: {
    Subpath?: string;
    NoCopy?: boolean;
  };
}

export interface ContainerCreateOptions {
  name: string;
  image: string;
  network?: string;
  binds?: string[]; // host:container volume mounts (legacy Binds API)
  mounts?: DockerMount[]; // modern Mounts API — required for VolumeOptions.Subpath
  env?: string[];
  memory?: number; // bytes
  cpus?: number;
  pidsLimit?: number;
  restartPolicy?: "no" | "always" | "unless-stopped" | "on-failure";
}

export interface ContainerInspectResult {
  Id: string;
  State: { Running: boolean; Status: string };
  NetworkSettings: {
    Networks: Record<string, { IPAddress: string }>;
  };
  Mounts?: Array<{
    Type: string;
    Name?: string;
    Source: string;
    Destination: string;
  }>;
}

export interface VolumeInspectResult {
  Name: string;
  Driver: string;
  Mountpoint: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// -- Docker Client --

export class DockerClient {
  private socket: string;
  private baseUrl: string;

  constructor(socket?: string) {
    const raw = socket ?? process.env.DOCKER_HOST ?? "/var/run/docker.sock";
    // DOCKER_HOST is conventionally a URI (`unix:///path/to/sock`,
    // `tcp://host:port`). The Docker CLI and most ecosystem tools expect
    // that form, but this client speaks raw HTTP-over-unix and needs the
    // bare filesystem path. Accept both so a single env var works for
    // every consumer.
    this.socket = raw.startsWith("unix://") ? raw.slice("unix://".length) : raw;
    this.baseUrl = `http://localhost/${API_VERSION}`;
  }

  private async fetch(path: string, init?: RequestInit): Promise<Response> {
    return unixFetch(`${this.baseUrl}${path}`, this.socket, init);
  }

  // -- System --

  async info(): Promise<boolean> {
    try {
      const res = await this.fetch("/info");
      return res.ok;
    } catch {
      return false;
    }
  }

  // -- Images --

  async imageExists(image: string): Promise<boolean> {
    const res = await this.fetch(`/images/${encodeURIComponent(image)}/json`);
    return res.ok;
  }

  async buildImage(
    tag: string,
    contextDir: string,
    opts?: { cacheFrom?: string; timeout?: number },
  ): Promise<{ log: string }> {
    const { spawn } = await import("child_process");
    const tarData = await new Promise<Buffer>((resolve, reject) => {
      const tarProc = spawn("tar", ["-cf", "-", "-C", contextDir, "."], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const chunks: Buffer[] = [];
      let stderr = "";
      tarProc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      tarProc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      tarProc.on("close", (code) => {
        if (code !== 0) reject(new Error(`Failed to create build context tar: ${stderr}`));
        else resolve(Buffer.concat(chunks));
      });
      tarProc.on("error", reject);
    });

    let queryParams = `t=${encodeURIComponent(tag)}`;
    if (opts?.cacheFrom) {
      queryParams += `&cachefrom=${encodeURIComponent(JSON.stringify([opts.cacheFrom]))}`;
    }

    const controller = new AbortController();
    const timeout = opts?.timeout ?? 5 * 60_000;
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const res = await this.fetch(`/build?${queryParams}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-tar" },
        body: tarData,
        signal: controller.signal,
      });

      if (!res.ok && !res.body) {
        throw new Error(`Build request failed: ${res.status} ${res.statusText}`);
      }

      const text = await res.text();
      const lines = text.split("\n").filter(Boolean);
      let buildLog = "";
      let errorMsg = "";

      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj.stream) buildLog += obj.stream;
          if (obj.error) errorMsg = obj.error;
        } catch {
          buildLog += line + "\n";
        }
      }

      if (errorMsg) {
        throw new Error(`Build failed: ${errorMsg}\n${buildLog.slice(-500)}`);
      }

      return { log: buildLog };
    } finally {
      clearTimeout(timer);
    }
  }

  async pullImage(image: string): Promise<void> {
    const parts = image.split(":");
    const fromImage = parts[0]!;
    const tag = parts[1] || "latest";
    const res = await this.fetch(
      `/images/create?fromImage=${encodeURIComponent(fromImage)}&tag=${encodeURIComponent(tag)}`,
      { method: "POST" },
    );
    if (!res.ok) {
      throw new Error(`Failed to pull image: ${res.status} ${res.statusText}`);
    }
    await res.text();
  }

  async tagImage(source: string, target: string): Promise<void> {
    const parts = target.split(":");
    const repo = parts[0]!;
    const tag = parts[1] || "latest";
    const res = await this.fetch(
      `/images/${encodeURIComponent(source)}/tag?repo=${encodeURIComponent(repo)}&tag=${encodeURIComponent(tag)}`,
      { method: "POST" },
    );
    if (!res.ok) {
      throw new Error(`Failed to tag image: ${res.status} ${res.statusText}`);
    }
  }

  async removeImage(image: string): Promise<void> {
    await this.fetch(`/images/${encodeURIComponent(image)}?force=true`, { method: "DELETE" });
  }

  // -- Containers --

  async createAndStartContainer(opts: ContainerCreateOptions): Promise<string> {
    const body: any = {
      Image: opts.image,
      Env: opts.env,
      HostConfig: {
        Binds: opts.binds,
        Mounts: opts.mounts,
        NetworkMode: opts.network,
        Memory: opts.memory,
        NanoCpus: opts.cpus ? opts.cpus * 1e9 : undefined,
        PidsLimit: opts.pidsLimit,
        RestartPolicy: opts.restartPolicy
          ? { Name: opts.restartPolicy }
          : undefined,
        CapAdd: ["SYS_ADMIN"],
        // fuse-overlayfs needs /dev/fuse to mount per-call workdirs; kernel
        // overlay mount is blocked on macOS+OrbStack/Docker Desktop hosts.
        Devices: [{ PathOnHost: "/dev/fuse", PathInContainer: "/dev/fuse", CgroupPermissions: "rwm" }],
      },
    };

    const createRes = await this.fetch(
      `/containers/create?name=${encodeURIComponent(opts.name)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );

    if (!createRes.ok) {
      const err = await createRes.text();
      throw new Error(`Failed to create container: ${err}`);
    }

    const { Id } = (await createRes.json()) as { Id: string };

    const startRes = await this.fetch(`/containers/${Id}/start`, { method: "POST" });
    if (!startRes.ok && startRes.status !== 304) {
      const err = await startRes.text();
      throw new Error(`Failed to start container: ${err}`);
    }

    return Id;
  }

  async inspectContainer(name: string): Promise<ContainerInspectResult> {
    const res = await this.fetch(`/containers/${encodeURIComponent(name)}/json`);
    if (!res.ok) {
      throw new Error(`Failed to inspect container ${name}: ${res.status}`);
    }
    return res.json() as Promise<ContainerInspectResult>;
  }

  async getContainerIp(name: string): Promise<string> {
    const info = await this.inspectContainer(name);
    const networks = info.NetworkSettings.Networks;
    const firstNetwork = Object.values(networks)[0];
    return firstNetwork?.IPAddress ?? "";
  }

  async isContainerRunning(name: string): Promise<boolean> {
    try {
      const info = await this.inspectContainer(name);
      return info.State.Running;
    } catch {
      return false;
    }
  }

  async pauseContainer(name: string): Promise<void> {
    await this.fetch(`/containers/${encodeURIComponent(name)}/pause`, { method: "POST" });
  }

  async unpauseContainer(name: string): Promise<void> {
    await this.fetch(`/containers/${encodeURIComponent(name)}/unpause`, { method: "POST" });
  }

  async stopContainer(name: string): Promise<void> {
    await this.fetch(`/containers/${encodeURIComponent(name)}/stop`, { method: "POST" });
  }

  async startContainer(name: string): Promise<void> {
    const res = await this.fetch(`/containers/${encodeURIComponent(name)}/start`, { method: "POST" });
    if (!res.ok && res.status !== 304) {
      throw new Error(`Failed to start container ${name}: ${res.status}`);
    }
  }

  async putArchive(containerName: string, containerPath: string, tarBuffer: Buffer | Uint8Array): Promise<void> {
    const res = await this.fetch(
      `/containers/${encodeURIComponent(containerName)}/archive?path=${encodeURIComponent(containerPath)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/x-tar" },
        body: tarBuffer as any,
      },
    );
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`putArchive failed: ${err}`);
    }
  }

  /** Streaming putArchive — pipes a tar stream directly to Docker without buffering. */
  async putArchiveStream(containerName: string, containerPath: string, tarStream: ReadableStream<Uint8Array>): Promise<void> {
    const url = `${this.baseUrl}/containers/${encodeURIComponent(containerName)}/archive?path=${encodeURIComponent(containerPath)}`;
    const res = await unixFetchStreamingPut(url, this.socket, tarStream, {
      "Content-Type": "application/x-tar",
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`putArchiveStream failed: ${err}`);
    }
  }

  async getArchive(containerName: string, containerPath: string): Promise<Buffer> {
    const res = await this.fetch(
      `/containers/${encodeURIComponent(containerName)}/archive?path=${encodeURIComponent(containerPath)}`,
    );
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`getArchive failed: ${err}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  /** Streaming getArchive — returns a ReadableStream of the tar data without buffering. */
  async getArchiveStream(containerName: string, containerPath: string): Promise<ReadableStream<Uint8Array>> {
    const url = `${this.baseUrl}/containers/${encodeURIComponent(containerName)}/archive?path=${encodeURIComponent(containerPath)}`;
    const res = await unixFetchStreaming(url, this.socket);
    if (!res.ok) {
      // Consume the stream to release resources
      if (res.body) await res.body.cancel();
      const err = `getArchiveStream failed: ${res.status} ${res.statusText}`;
      throw new Error(err);
    }
    return res.body!;
  }

  async removeContainer(name: string, force = true): Promise<void> {
    await this.fetch(
      `/containers/${encodeURIComponent(name)}?force=${force}`,
      { method: "DELETE" },
    );
  }

  async renameContainer(name: string, newName: string): Promise<void> {
    const res = await this.fetch(
      `/containers/${encodeURIComponent(name)}/rename?name=${encodeURIComponent(newName)}`,
      { method: "POST" },
    );
    if (!res.ok) {
      throw new Error(`Failed to rename container: ${res.status}`);
    }
  }

  async getContainerLogs(name: string, tail: number = 100): Promise<string> {
    const res = await this.fetch(
      `/containers/${encodeURIComponent(name)}/logs?stdout=true&stderr=true&tail=${tail}`,
    );
    if (!res.ok) return "";
    const raw = new Uint8Array(await res.arrayBuffer());
    return parseDockerLogs(raw);
  }

  // -- Exec --

  async exec(containerName: string, cmd: string[], opts?: { timeout?: number; workingDir?: string }): Promise<ExecResult> {
    const createRes = await this.fetch(
      `/containers/${encodeURIComponent(containerName)}/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          Cmd: cmd,
          AttachStdout: true,
          AttachStderr: true,
          WorkingDir: opts?.workingDir ?? "/workspace",
        }),
      },
    );

    if (!createRes.ok) {
      const err = await createRes.text();
      throw new Error(`Failed to create exec: ${err}`);
    }

    const { Id: execId } = (await createRes.json()) as { Id: string };

    const controller = new AbortController();
    const timeout = opts?.timeout ?? 120_000;
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const startRes = await this.fetch(`/exec/${execId}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ Detach: false }),
        signal: controller.signal,
      });

      if (!startRes.ok) {
        const err = await startRes.text();
        throw new Error(`Failed to start exec: ${err}`);
      }

      const raw = new Uint8Array(await startRes.arrayBuffer());
      const { stdout, stderr } = demuxDockerStream(raw);

      const inspectRes = await this.fetch(`/exec/${execId}/json`);
      const inspectData = (await inspectRes.json()) as { ExitCode: number };

      return { stdout, stderr, exitCode: inspectData.ExitCode };
    } finally {
      clearTimeout(timer);
    }
  }

  // -- List / Filter --

  async listContainers(opts?: { all?: boolean; filters?: Record<string, string[]> }): Promise<Array<{ Id: string; Names: string[]; State: string }>> {
    const params = new URLSearchParams();
    if (opts?.all) params.set("all", "true");
    if (opts?.filters) params.set("filters", JSON.stringify(opts.filters));
    const res = await this.fetch(`/containers/json?${params}`);
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to list containers: ${err}`);
    }
    return res.json() as Promise<Array<{ Id: string; Names: string[]; State: string }>>;
  }

  // -- Networks --

  async networkExists(name: string): Promise<boolean> {
    const res = await this.fetch(`/networks/${encodeURIComponent(name)}`);
    return res.ok;
  }

  async createNetwork(name: string): Promise<void> {
    const res = await this.fetch("/networks/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ Name: name, Driver: "bridge" }),
    });
    // Swallowing this hid pool-exhaustion behind a later "network not found".
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to create network (${res.status} ${res.statusText}): ${err}`);
    }
  }

  async removeNetwork(name: string): Promise<void> {
    await this.fetch(`/networks/${encodeURIComponent(name)}`, { method: "DELETE" });
  }

  async connectNetwork(networkName: string, containerName: string): Promise<void> {
    const res = await this.fetch(`/networks/${encodeURIComponent(networkName)}/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ Container: containerName }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to connect container to network: ${err}`);
    }
  }

  async disconnectNetwork(networkName: string, containerName: string): Promise<void> {
    await this.fetch(`/networks/${encodeURIComponent(networkName)}/disconnect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ Container: containerName }),
    });
  }

  async ensureNetwork(name: string): Promise<void> {
    if (await this.networkExists(name)) return;
    await this.createNetwork(name);
  }

  // -- Volumes --

  async inspectVolume(name: string): Promise<VolumeInspectResult | null> {
    const res = await this.fetch(`/volumes/${encodeURIComponent(name)}`);
    if (!res.ok) return null;
    return res.json() as Promise<VolumeInspectResult>;
  }
}

// -- Docker stream protocol helpers --

function demuxDockerStream(data: Uint8Array): { stdout: string; stderr: string } {
  const stdoutChunks: Uint8Array[] = [];
  const stderrChunks: Uint8Array[] = [];
  let offset = 0;

  while (offset + 8 <= data.length) {
    const streamType = data[offset]!;
    const size =
      (data[offset + 4]! << 24) |
      (data[offset + 5]! << 16) |
      (data[offset + 6]! << 8) |
      data[offset + 7]!;
    offset += 8;

    if (offset + size > data.length) break;

    const payload = data.subarray(offset, offset + size);
    if (streamType === 1) {
      stdoutChunks.push(payload);
    } else if (streamType === 2) {
      stderrChunks.push(payload);
    }
    offset += size;
  }

  const decoder = new TextDecoder();
  return {
    stdout: decoder.decode(concatUint8Arrays(stdoutChunks)),
    stderr: decoder.decode(concatUint8Arrays(stderrChunks)),
  };
}

function parseDockerLogs(data: Uint8Array): string {
  const { stdout, stderr } = demuxDockerStream(data);
  return stdout + (stderr ? "\n" + stderr : "");
}

function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
  if (arrays.length === 0) return new Uint8Array(0);
  if (arrays.length === 1) return arrays[0]!;
  const totalLength = arrays.reduce((acc, arr) => acc + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

export const docker = new DockerClient();
