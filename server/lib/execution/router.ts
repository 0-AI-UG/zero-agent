import type { ExecutionBackend } from "./types.ts";
import { CompanionBackend } from "./companion-backend.ts";
import { log } from "@/lib/logger.ts";
import { getSetting } from "@/lib/settings.ts";

const routerLog = log.child({ module: "execution-router" });

/**
 * Routes execution requests to the best available backend.
 * Priority: companion (if connected) > local backend (if dockerd available) > error
 */
class BackendRouter {
  private companion = new CompanionBackend();
  private local: ExecutionBackend | null = null;

  /** Register the local (DinD) backend once dockerd is ready. */
  setLocalBackend(backend: ExecutionBackend): void {
    this.local = backend;
    routerLog.info("local execution backend registered");
  }

  /** Whether server-side execution is enabled by the admin. */
  private isServerExecutionEnabled(): boolean {
    return getSetting("SERVER_EXECUTION_ENABLED") !== "false";
  }

  /**
   * Get the best available backend for a given user/project.
   * Companion-first preserves the option for users who want their own Chrome profile/cookies.
   */
  getBackend(userId: string, projectId: string): ExecutionBackend | null {
    // Prefer companion if connected
    if (this.companion.isAvailable(userId, projectId)) {
      routerLog.info("routed to companion backend", { userId, projectId });
      return this.companion;
    }
    // Fall back to local backend (only if admin has not disabled server execution)
    if (this.isServerExecutionEnabled() && this.local?.isAvailable(userId, projectId)) {
      routerLog.info("routed to local backend", { userId, projectId });
      return this.local;
    }
    routerLog.warn("no backend available", { userId, projectId, serverExecutionEnabled: this.isServerExecutionEnabled(), hasLocal: !!this.local });
    return null;
  }

  /** Check if any backend is available. */
  isAvailable(userId: string, projectId: string): boolean {
    return this.getBackend(userId, projectId) !== null;
  }

  /** Whether the local (server-side) Docker backend is registered and enabled. */
  hasLocalBackend(): boolean {
    return this.isServerExecutionEnabled() && this.local !== null;
  }
}

export const backendRouter = new BackendRouter();
