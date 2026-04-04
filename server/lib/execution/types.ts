import type { BrowserAction, BrowserResult, CompanionStatus } from "@/lib/browser/protocol.ts";

/**
 * Unified execution backend interface.
 * Both companion (WebSocket-based) and local (DinD-based) backends implement this.
 */
export interface ExecutionBackend {
  // ── Availability ──
  isAvailable(userId: string, projectId: string): boolean;
  getStatus(userId: string, projectId: string): CompanionStatus;

  // ── Browser ──
  execute(userId: string, projectId: string, action: BrowserAction, sessionId?: string, stealth?: boolean): Promise<BrowserResult>;
  createSession(userId: string, projectId: string, sessionId: string, label?: string): Promise<void>;
  destroySession(userId: string, projectId: string, sessionId: string): Promise<void>;

  // ── Code execution ──
  createWorkspace(userId: string, projectId: string, workspaceId: string, manifest: Record<string, string>): Promise<void>;
  syncWorkspace(userId: string, projectId: string, workspaceId: string, manifest: Record<string, string>): Promise<void>;
  runBash(userId: string, projectId: string, workspaceId: string, command: string, timeout?: number): Promise<BashResult>;
  destroyWorkspace(userId: string, projectId: string, workspaceId: string): Promise<void>;
}

export interface BashResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  changedFiles?: Array<{ path: string; data: string; sizeBytes: number }>;
  deletedFiles?: string[];
}
