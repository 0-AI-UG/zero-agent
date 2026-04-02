import type { ServerWebSocket } from "bun";
import type {
  BrowserAction,
  BrowserResult,
  BrowserCommand,
  CompanionControl,
  CompanionMessage,
  CompanionStatus,
  WebAuthnSubCommand,
} from "./protocol.ts";
import { nanoid } from "nanoid";
import { events } from "@/lib/events.ts";
import { log } from "@/lib/logger.ts";
import { DESKTOP_MODE } from "@/lib/auth.ts";
import { getUserById } from "@/db/queries/users.ts";
import { clearReadyWorkspaces } from "@/tools/code.ts";

const bridgeLog = log.child({ module: "browser-bridge" });

const COMMAND_TIMEOUT = 30_000;
const PING_INTERVAL = 10_000;
const PONG_TIMEOUT = 5_000;

interface CompanionConnection {
  ws: ServerWebSocket<{ userId: string; projectId: string }>;
  status: CompanionStatus;
  pingTimer: ReturnType<typeof setInterval>;
  pongTimer?: ReturnType<typeof setTimeout>;
  pendingCommandIds: Set<string>;
  pendingSessionIds: Set<string>;
  pendingWorkspaceIds: Set<string>;
  pendingCodeIds: Set<string>;
  pendingWebAuthnIds: Set<string>;
  /** Lazily-initialized virtual authenticator for passkey operations. */
  authenticatorId?: string;
  /** In-flight authenticator init promise (deduplicates concurrent calls). */
  authenticatorInit?: Promise<string>;
}

interface PendingWebAuthnCommand {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingCommand {
  resolve: (result: BrowserResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingSession {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingWorkspaceOp {
  resolve: (result: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function connKey(userId: string, projectId: string): string {
  return `${userId}:${projectId}`;
}

class BrowserBridge {
  private companions = new Map<string, CompanionConnection>();
  private pending = new Map<string, PendingCommand>();
  private pendingSessions = new Map<string, PendingSession>();
  private pendingWorkspace = new Map<string, PendingWorkspaceOp>();
  private pendingCode = new Map<string, PendingWorkspaceOp>();
  private pendingWebAuthn = new Map<string, PendingWebAuthnCommand>();

  handleOpen(ws: ServerWebSocket<{ userId: string; projectId: string }>) {
    const { userId, projectId } = ws.data;
    const key = connKey(userId, projectId);
    bridgeLog.info("companion connected", { userId, projectId });

    // Close existing connection if any
    const existing = this.companions.get(key);
    if (existing) {
      clearInterval(existing.pingTimer);
      try { existing.ws.close(1000, "replaced"); } catch {}
    }

    const pingTimer = setInterval(() => {
      try {
        const conn = this.companions.get(key);
        if (!conn || conn.ws !== ws) {
          clearInterval(pingTimer);
          return;
        }

        // If there's already a pong timer running, the previous pong never arrived — stale
        if (conn.pongTimer) {
          bridgeLog.warn("companion pong timeout, closing stale connection", { userId, projectId });
          this.handleClose(ws);
          try { ws.close(1000, "pong timeout"); } catch {}
          return;
        }

        const msg: CompanionControl = { type: "ping" };
        ws.send(JSON.stringify(msg));

        // Start a pong timer — if pong doesn't arrive within PONG_TIMEOUT, mark as stale
        conn.pongTimer = setTimeout(() => {
          // Don't close here — let the next ping interval detect the stale pongTimer
        }, PONG_TIMEOUT);
      } catch {
        this.handleClose(ws);
      }
    }, PING_INTERVAL);

    this.companions.set(key, {
      ws,
      status: { connected: true },
      pingTimer,
      pendingCommandIds: new Set(),
      pendingSessionIds: new Set(),
      pendingWorkspaceIds: new Set(),
      pendingCodeIds: new Set(),
      pendingWebAuthnIds: new Set(),
    });

    events.emit("companion.connected", { projectId, userId });
  }

  handleMessage(ws: ServerWebSocket<{ userId: string; projectId: string }>, message: string | Buffer) {
    const { userId, projectId } = ws.data;
    const key = connKey(userId, projectId);
    try {
      const data = JSON.parse(typeof message === "string" ? message : message.toString()) as CompanionMessage;

      if (data.type === "pong") {
        const conn = this.companions.get(key);
        if (conn?.pongTimer) {
          clearTimeout(conn.pongTimer);
          conn.pongTimer = undefined;
        }
        return;
      }

      if (data.type === "status") {
        const conn = this.companions.get(key);
        if (conn) {
          conn.status.browserUrl = data.url;
          conn.status.browserTitle = data.title;
          if (data.capabilities) {
            conn.status.dockerInstalled = data.capabilities.dockerInstalled;
            conn.status.dockerRunning = data.capabilities.dockerRunning;
            conn.status.chromeAvailable = data.capabilities.chromeAvailable;
          }
        }
        return;
      }

      if (data.type === "response") {
        const { response } = data;
        const pending = this.pending.get(response.id);
        if (!pending) return;

        clearTimeout(pending.timer);
        this.pending.delete(response.id);
        this.companions.get(key)?.pendingCommandIds.delete(response.id);

        if (response.error) {
          pending.reject(new Error(response.error));
        } else if (response.result) {
          pending.resolve(response.result);
        } else {
          pending.reject(new Error("Empty response from companion"));
        }
        return;
      }

      // Session lifecycle responses
      if (data.type === "sessionCreated" || data.type === "sessionDestroyed") {
        const pending = this.pendingSessions.get(data.sessionId);
        if (pending) {
          this.pendingSessions.delete(data.sessionId);
          this.companions.get(key)?.pendingSessionIds.delete(data.sessionId);
          clearTimeout(pending.timer);
          pending.resolve();
        }
        return;
      }

      if (data.type === "sessionError") {
        const pending = this.pendingSessions.get(data.sessionId);
        if (pending) {
          this.pendingSessions.delete(data.sessionId);
          this.companions.get(key)?.pendingSessionIds.delete(data.sessionId);
          clearTimeout(pending.timer);
          pending.reject(new Error(data.error));
        }
        return;
      }

      // ── Workspace lifecycle handlers ──

      if (data.type === "workspaceCreated" || data.type === "workspaceSynced") {
        const pending = this.pendingWorkspace.get(data.workspaceId);
        if (pending) {
          this.pendingWorkspace.delete(data.workspaceId);
          this.companions.get(key)?.pendingWorkspaceIds.delete(data.workspaceId);
          clearTimeout(pending.timer);
          pending.resolve(undefined);
        }
        return;
      }

      if (data.type === "workspaceDestroyed") {
        const pending = this.pendingWorkspace.get(data.workspaceId);
        if (pending) {
          this.pendingWorkspace.delete(data.workspaceId);
          this.companions.get(key)?.pendingWorkspaceIds.delete(data.workspaceId);
          clearTimeout(pending.timer);
          pending.resolve(undefined);
        }
        return;
      }

      // ── Code execution result ──

      if (data.type === "bashResult") {
        const pending = this.pendingCode.get(data.commandId);
        if (pending) {
          this.pendingCode.delete(data.commandId);
          this.companions.get(key)?.pendingCodeIds.delete(data.commandId);
          clearTimeout(pending.timer);
          pending.resolve({
            stdout: data.stdout,
            stderr: data.stderr,
            exitCode: data.exitCode,
            ...(data.changedFiles ? { changedFiles: data.changedFiles } : {}),
            ...(data.deletedFiles ? { deletedFiles: data.deletedFiles } : {}),
          });
        }
        return;
      }

      // ── Workspace error (covers both lifecycle and code execution errors) ──

      if (data.type === "workspaceError") {
        // Try commandId first (code execution error), then workspaceId (lifecycle error)
        if (data.commandId) {
          const pending = this.pendingCode.get(data.commandId);
          if (pending) {
            this.pendingCode.delete(data.commandId);
            this.companions.get(key)?.pendingCodeIds.delete(data.commandId);
            clearTimeout(pending.timer);
            pending.reject(new Error(data.error));
            return;
          }
        }
        const pending = this.pendingWorkspace.get(data.workspaceId);
        if (pending) {
          this.pendingWorkspace.delete(data.workspaceId);
          this.companions.get(key)?.pendingWorkspaceIds.delete(data.workspaceId);
          clearTimeout(pending.timer);
          pending.reject(new Error(data.error));
        }
        return;
      }

      // ── WebAuthn message handlers ──

      if (data.type === "webauthnResult") {
        const pending = this.pendingWebAuthn.get(data.commandId);
        if (pending) {
          this.pendingWebAuthn.delete(data.commandId);
          this.companions.get(key)?.pendingWebAuthnIds.delete(data.commandId);
          clearTimeout(pending.timer);
          pending.resolve(data.result);
        }
        return;
      }

      if (data.type === "webauthnError") {
        const pending = this.pendingWebAuthn.get(data.commandId);
        if (pending) {
          this.pendingWebAuthn.delete(data.commandId);
          this.companions.get(key)?.pendingWebAuthnIds.delete(data.commandId);
          clearTimeout(pending.timer);
          pending.reject(new Error(data.error));
        }
        return;
      }
    } catch (err) {
      bridgeLog.error("failed to parse companion message", err, { userId, projectId });
    }
  }

  handleClose(ws: ServerWebSocket<{ userId: string; projectId: string }>) {
    const { userId, projectId } = ws.data;
    const key = connKey(userId, projectId);
    const conn = this.companions.get(key);
    if (conn && conn.ws === ws) {
      clearInterval(conn.pingTimer);
      if (conn.pongTimer) clearTimeout(conn.pongTimer);
      this.companions.delete(key);
      bridgeLog.info("companion disconnected", { userId, projectId });
      events.emit("companion.disconnected", { projectId, userId });
      clearReadyWorkspaces();

      const disconnectError = new Error("Browser companion disconnected");

      // Reject only this connection's pending commands so other users aren't affected
      for (const id of conn.pendingCommandIds) {
        const pending = this.pending.get(id);
        if (pending) {
          clearTimeout(pending.timer);
          pending.reject(disconnectError);
          this.pending.delete(id);
        }
      }
      for (const id of conn.pendingSessionIds) {
        const pending = this.pendingSessions.get(id);
        if (pending) {
          clearTimeout(pending.timer);
          pending.reject(disconnectError);
          this.pendingSessions.delete(id);
        }
      }
      for (const id of conn.pendingWorkspaceIds) {
        const pending = this.pendingWorkspace.get(id);
        if (pending) {
          clearTimeout(pending.timer);
          pending.reject(disconnectError);
          this.pendingWorkspace.delete(id);
        }
      }
      for (const id of conn.pendingCodeIds) {
        const pending = this.pendingCode.get(id);
        if (pending) {
          clearTimeout(pending.timer);
          pending.reject(disconnectError);
          this.pendingCode.delete(id);
        }
      }
      for (const id of conn.pendingWebAuthnIds) {
        const pending = this.pendingWebAuthn.get(id);
        if (pending) {
          clearTimeout(pending.timer);
          pending.reject(disconnectError);
          this.pendingWebAuthn.delete(id);
        }
      }
    }
  }

  async execute(userId: string, projectId: string, action: BrowserAction, sessionId?: string, stealth?: boolean): Promise<BrowserResult> {
    const conn = this.findConnection(userId, projectId);
    if (!conn) {
      throw new Error("Browser companion is not connected. Please start the companion agent on your machine.");
    }

    const id = nanoid();
    const command: BrowserCommand = { id, action, sessionId, stealth };

    return new Promise<BrowserResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        conn.pendingCommandIds.delete(id);
        reject(new Error(`Browser command timed out after ${COMMAND_TIMEOUT / 1000}s`));
      }, COMMAND_TIMEOUT);

      this.pending.set(id, { resolve, reject, timer });
      conn.pendingCommandIds.add(id);

      const msg: CompanionControl = { type: "command", command };
      conn.ws.send(JSON.stringify(msg));
    });
  }

  async createSession(userId: string, projectId: string, sessionId: string, label?: string): Promise<void> {
    const conn = this.findConnection(userId, projectId);
    if (!conn) {
      throw new Error("Browser companion is not connected.");
    }

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingSessions.delete(sessionId);
        conn.pendingSessionIds.delete(sessionId);
        reject(new Error("Session creation timed out"));
      }, COMMAND_TIMEOUT);

      this.pendingSessions.set(sessionId, { resolve, reject, timer });
      conn.pendingSessionIds.add(sessionId);

      const msg: CompanionControl = { type: "createSession", sessionId, label };
      conn.ws.send(JSON.stringify(msg));
    });
  }

  async destroySession(userId: string, projectId: string, sessionId: string): Promise<void> {
    const conn = this.findConnection(userId, projectId);
    if (!conn) return; // Companion gone, session already dead

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingSessions.delete(sessionId);
        conn.pendingSessionIds.delete(sessionId);
        resolve(); // Don't fail on destroy timeout — best effort
      }, COMMAND_TIMEOUT);

      this.pendingSessions.set(sessionId, { resolve, reject, timer });
      conn.pendingSessionIds.add(sessionId);

      const msg: CompanionControl = { type: "destroySession", sessionId };
      conn.ws.send(JSON.stringify(msg));
    });
  }

  // ── Workspace Methods ──

  async createWorkspace(userId: string, projectId: string, workspaceId: string, manifest: Record<string, string>): Promise<void> {
    const conn = this.findConnection(userId, projectId);
    if (!conn) throw new Error("Browser companion is not connected.");

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingWorkspace.delete(workspaceId);
        conn.pendingWorkspaceIds.delete(workspaceId);
        reject(new Error("Environment setup timed out"));
      }, 60_000);

      this.pendingWorkspace.set(workspaceId, { resolve, reject, timer });
      conn.pendingWorkspaceIds.add(workspaceId);
      const msg: CompanionControl = { type: "createWorkspace", workspaceId, manifest };
      conn.ws.send(JSON.stringify(msg));
    });
  }

  async syncWorkspace(userId: string, projectId: string, workspaceId: string, manifest: Record<string, string>): Promise<void> {
    const conn = this.findConnection(userId, projectId);
    if (!conn) throw new Error("Browser companion is not connected.");

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingWorkspace.delete(workspaceId);
        conn.pendingWorkspaceIds.delete(workspaceId);
        reject(new Error("File sync timed out"));
      }, 60_000);

      this.pendingWorkspace.set(workspaceId, { resolve, reject, timer });
      conn.pendingWorkspaceIds.add(workspaceId);
      const msg: CompanionControl = { type: "syncWorkspace", workspaceId, manifest };
      conn.ws.send(JSON.stringify(msg));
    });
  }

  async runBash(
    userId: string,
    projectId: string,
    workspaceId: string,
    command: string,
    timeout?: number,
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
    changedFiles?: Array<{ path: string; data: string; sizeBytes: number }>;
    deletedFiles?: string[];
  }> {
    const conn = this.findConnection(userId, projectId);
    if (!conn) throw new Error("Browser companion is not connected.");

    const commandId = nanoid();
    const bridgeTimeout = (timeout ?? 120_000) + 10_000;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCode.delete(commandId);
        conn.pendingCodeIds.delete(commandId);
        reject(new Error("Command execution timed out"));
      }, bridgeTimeout);

      this.pendingCode.set(commandId, { resolve, reject, timer });
      conn.pendingCodeIds.add(commandId);
      const msg: CompanionControl = {
        type: "runBash",
        workspaceId,
        commandId,
        command,
        timeout,
      };
      conn.ws.send(JSON.stringify(msg));
    });
  }

  async sendWebAuthnCommand(userId: string, projectId: string, subCommand: WebAuthnSubCommand): Promise<unknown> {
    const conn = this.findConnection(userId, projectId);
    if (!conn) {
      throw new Error("Browser companion is not connected. Please start the companion agent on your machine.");
    }

    const { commandId } = subCommand;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingWebAuthn.delete(commandId);
        conn.pendingWebAuthnIds.delete(commandId);
        reject(new Error(`WebAuthn command timed out after ${COMMAND_TIMEOUT / 1000}s`));
      }, COMMAND_TIMEOUT);

      this.pendingWebAuthn.set(commandId, { resolve, reject, timer });
      conn.pendingWebAuthnIds.add(commandId);

      const msg: CompanionControl = { type: "webauthn", subCommand };
      conn.ws.send(JSON.stringify(msg));
    });
  }

  /**
   * Lazily enable WebAuthn and create a virtual authenticator on the companion.
   * Returns the cached authenticator ID on subsequent calls.
   */
  async ensureAuthenticator(userId: string, projectId: string): Promise<string> {
    const conn = this.findConnection(userId, projectId);
    if (!conn) {
      throw new Error("Browser companion is not connected. Please start the companion agent on your machine.");
    }

    if (conn.authenticatorId) return conn.authenticatorId;

    // Deduplicate concurrent calls
    if (conn.authenticatorInit) return conn.authenticatorInit;

    conn.authenticatorInit = (async () => {
      await this.sendWebAuthnCommand(userId, projectId, {
        type: "enable",
        commandId: nanoid(),
      });

      const result = await this.sendWebAuthnCommand(userId, projectId, {
        type: "addAuthenticator",
        commandId: nanoid(),
        options: {
          protocol: "ctap2",
          transport: "internal",
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
        },
      }) as { authenticatorId: string };

      conn.authenticatorId = result.authenticatorId;
      conn.authenticatorInit = undefined;
      bridgeLog.info("virtual authenticator ready", { userId, projectId, authenticatorId: result.authenticatorId });
      return result.authenticatorId;
    })();

    return conn.authenticatorInit;
  }

  /**
   * Find a companion connection for the project.
   * Prefers the given user's own connection, falls back to any project member's.
   * In desktop mode, falls back to any companion (single user, single companion).
   */
  private findConnection(userId: string, projectId: string): CompanionConnection | undefined {
    // Try the requesting user's own companion first
    const own = this.companions.get(connKey(userId, projectId));
    if (own) return own;

    // Fall back to any companion connected for this project whose owner allows sharing
    const suffix = `:${projectId}`;
    for (const [key, conn] of this.companions) {
      if (key.endsWith(suffix)) {
        const ownerId = key.split(":")[0]!;
        const owner = getUserById(ownerId);
        if (owner?.companion_sharing === 1) return conn;
      }
    }

    // In desktop mode, there's a single companion instance — use it for any project
    if (DESKTOP_MODE) {
      for (const [, conn] of this.companions) {
        return conn;
      }
    }

    return undefined;
  }

  isConnected(userId: string, projectId: string): boolean {
    return this.findConnection(userId, projectId) !== undefined;
  }

  getStatus(userId: string, projectId: string): CompanionStatus {
    const conn = this.findConnection(userId, projectId);
    if (!conn) return { connected: false };
    return { ...conn.status };
  }

  /** Find any connected companion for a project (any member who allows sharing). */
  findConnectedMember(projectId: string, memberUserIds: string[]): string | undefined {
    for (const userId of memberUserIds) {
      if (this.companions.has(connKey(userId, projectId))) {
        const user = getUserById(userId);
        if (user?.companion_sharing === 1) return userId;
      }
    }
    // In desktop mode, any companion connection belongs to the single user
    if (DESKTOP_MODE) {
      for (const [key] of this.companions) {
        const userId = key.split(":")[0] ?? "";
        if (memberUserIds.includes(userId)) return userId;
      }
    }
    return undefined;
  }
}

export const browserBridge = new BrowserBridge();
