/**
 * ExecutionBackend - interface for the execution backend (RunnerClient).
 * Tools and lifecycle code depend on this interface, not concrete implementations.
 */
import type { BrowserAction, BrowserResult } from "@/lib/browser/protocol.ts";
import type { TurnDiffEntry } from "@/lib/snapshots/types.ts";

export type WatcherEvent =
  | { kind: "upsert"; path: string; size: number; mtime: number }
  | { kind: "delete"; path: string };

export interface BashResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SessionInfo {
  sessionId: string;
  containerIp: string;
  containerName: string;
  /** User who most recently provisioned this session. Used by the
   *  runner-proxy CLI handlers to resolve container → principal. */
  userId: string;
}

export interface ContainerListEntry {
  sessionId: string;
  userId: string;
  projectId: string;
  status: string;
  lastUsedAt: number;
  runnerName?: string;
}

export interface ExecutionBackend {
  isReady(): boolean;

  ensureContainer(userId: string, projectId: string): Promise<void>;
  destroyContainer(projectId: string): Promise<void>;
  pushFile(projectId: string, relativePath: string, buffer: Buffer, workdirId?: string): Promise<void>;
  deleteFile(projectId: string, relativePath: string, workdirId?: string): Promise<void>;
  /** Read a single file from /workspace. Returns null if the file does not exist. */
  readFile(projectId: string, relativePath: string, workdirId?: string): Promise<Buffer | null>;
  /** Write a single file under /workspace. Alias for pushFile. */
  writeFile(projectId: string, relativePath: string, buffer: Buffer, workdirId?: string): Promise<void>;
  /** Stream a single file from /workspace. Returns null if the file does not exist. */
  readFileStream(projectId: string, relativePath: string, workdirId?: string): Promise<{ stream: ReadableStream<Uint8Array>; size: number; mimeType?: string } | null>;
  /** Fetch a sha256 manifest of files under `subpath` (default /workspace) inside the container. */
  getContainerManifest(projectId: string, subpath?: string, workdirId?: string): Promise<Record<string, string>>;

  touchActivity(projectId: string): void;

  runBash(userId: string, projectId: string, command: string, timeout?: number, background?: boolean, workdirId?: string): Promise<BashResult>;
  execute(userId: string, projectId: string, action: BrowserAction, stealth?: boolean): Promise<BrowserResult>;
  getLatestScreenshot(projectId: string): Promise<{ base64: string; title: string; url: string; timestamp: number } | null>;

  /** Subscribe to the container-side watcher's change stream. Resolves when the stream ends (abort or remote close). */
  streamWatcherEvents(projectId: string, onEvent: (event: WatcherEvent) => void, signal: AbortSignal): Promise<void>;
  /** Wait for the watcher's pending debounce timers to fire + events to be delivered. */
  flushWatcher(projectId: string): Promise<void>;

  /** Run a raw command in the project's container (used by port detection). */
  execInContainer(projectId: string, cmd: string[], opts?: { timeout?: number; workingDir?: string; workdirId?: string }): Promise<ExecResult>;

  /** Check if a port inside a container is accepting connections. */
  checkPort(projectId: string, port: number): Promise<boolean>;

  /** Get proxy URL and auth for routing to the correct runner. */
  getProxyInfo(projectId: string, port: number, path: string): { url: string; apiKey: string };

  getSessionForProject(projectId: string): SessionInfo | null;
  hasContainer(projectId: string): Promise<boolean>;
  ensureSessionForProject(projectId: string, userId: string): Promise<SessionInfo>;
  listContainers(): ContainerListEntry[];
  listContainersAsync(): Promise<ContainerListEntry[]>;
  destroyAll(): Promise<void>;

  /** Per-turn git snapshots (optional — only runner-backed backends implement these). */
  createSnapshot?(projectId: string, message: string): Promise<{ commitSha: string }>;
  getSnapshotDiff?(projectId: string, sha: string, against: string): Promise<TurnDiffEntry[]>;
  readSnapshotFile?(projectId: string, sha: string, path: string): Promise<Buffer>;
  revertSnapshotPaths?(projectId: string, sha: string, paths: string[]): Promise<{ reverted: string[] }>;

  /** Phase 4 file ops routed through the runner. Paths are /workspace-relative and must not contain `..` or a leading `/`. */
  importFromS3?(projectId: string, req: { path: string; url: string; expectedHash: string }, workdirId?: string): Promise<{ status: "written" | "skipped-same-hash"; bytes: number }>;
  deletePath?(projectId: string, path: string, workdirId?: string): Promise<void>;
  movePath?(projectId: string, fromPath: string, toPath: string, workdirId?: string): Promise<void>;

  /** Phase 5 per-call overlayfs workdirs (optional — runner-backed backends only). */
  allocateWorkdir?(projectId: string): Promise<{ id: string }>;
  flushWorkdir?(projectId: string, id: string): Promise<{ changes: number }>;
  dropWorkdir?(projectId: string, id: string): Promise<void>;
  listWorkdirs?(projectId: string): Promise<Array<{ id: string; allocatedAt: number }>>;
}
