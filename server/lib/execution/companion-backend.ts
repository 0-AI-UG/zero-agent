import { browserBridge } from "@/lib/browser/bridge.ts";
import type { BrowserAction, BrowserResult, CompanionStatus } from "@/lib/browser/protocol.ts";
import type { ExecutionBackend, BashResult } from "./types.ts";

/**
 * Companion backend — thin adapter that delegates to the existing BrowserBridge singleton.
 * This preserves the WebSocket-based companion flow for users who connect their own browser.
 */
export class CompanionBackend implements ExecutionBackend {
  isAvailable(userId: string, projectId: string): boolean {
    return browserBridge.isConnected(userId, projectId);
  }

  getStatus(userId: string, projectId: string): CompanionStatus {
    return browserBridge.getStatus(userId, projectId);
  }

  async execute(userId: string, projectId: string, action: BrowserAction, sessionId?: string, stealth?: boolean): Promise<BrowserResult> {
    return browserBridge.execute(userId, projectId, action, sessionId, stealth);
  }

  async createSession(userId: string, projectId: string, sessionId: string, label?: string): Promise<void> {
    return browserBridge.createSession(userId, projectId, sessionId, label);
  }

  async destroySession(userId: string, projectId: string, sessionId: string): Promise<void> {
    return browserBridge.destroySession(userId, projectId, sessionId);
  }

  async createWorkspace(userId: string, projectId: string, workspaceId: string, manifest: Record<string, string>): Promise<void> {
    return browserBridge.createWorkspace(userId, projectId, workspaceId, manifest);
  }

  async syncWorkspace(userId: string, projectId: string, workspaceId: string, manifest: Record<string, string>): Promise<void> {
    return browserBridge.syncWorkspace(userId, projectId, workspaceId, manifest);
  }

  async runBash(userId: string, projectId: string, workspaceId: string, command: string, timeout?: number): Promise<BashResult> {
    return browserBridge.runBash(userId, projectId, workspaceId, command, timeout);
  }

  async destroyWorkspace(_userId: string, _projectId: string, _workspaceId: string): Promise<void> {
    // Companion handles workspace destruction via idle timeout
  }
}
