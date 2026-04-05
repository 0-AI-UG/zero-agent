/**
 * ExecutionBackend — interface for the execution backend (RunnerClient).
 * Tools and lifecycle code depend on this interface, not concrete implementations.
 */
import type { BrowserAction, BrowserResult } from "@/lib/browser/protocol.ts";

export interface BashResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  changedFiles?: Array<{ path: string; data: string; sizeBytes: number }>;
  deletedFiles?: string[];
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
  syncProjectFiles(projectId: string, manifest: Record<string, string>): Promise<void>;
  touchActivity(projectId: string): void;

  runBash(userId: string, projectId: string, command: string, timeout?: number, background?: boolean): Promise<BashResult>;
  execute(userId: string, projectId: string, action: BrowserAction, stealth?: boolean): Promise<BrowserResult>;
  getLatestScreenshot(projectId: string): Promise<{ base64: string; title: string; url: string; timestamp: number } | null>;

  /** Run a raw command in the project's container (used by port detection). */
  execInContainer(projectId: string, cmd: string[], opts?: { timeout?: number; workingDir?: string }): Promise<ExecResult>;

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
}
