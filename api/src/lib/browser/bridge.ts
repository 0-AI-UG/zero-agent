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
import { log } from "@/lib/logger.ts";

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
  pendingSandboxIds: Set<string>;
  pendingSessionIds: Set<string>;
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

interface PendingSandboxCommand {
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
  private pendingSandbox = new Map<string, PendingSandboxCommand>();
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
      pendingSandboxIds: new Set(),
      pendingSessionIds: new Set(),
      pendingWebAuthnIds: new Set(),
    });
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

      // ── Sandbox message handlers ──

      if (data.type === "sandboxCreated") {
        const pending = this.pendingSandbox.get(data.sandboxId);
        if (pending) {
          this.pendingSandbox.delete(data.sandboxId);
          this.companions.get(key)?.pendingSandboxIds.delete(data.sandboxId);
          clearTimeout(pending.timer);
          pending.resolve({ pythonVersion: data.pythonVersion });
        }
        return;
      }

      if (data.type === "scriptResult") {
        const pending = this.pendingSandbox.get(data.commandId);
        if (pending) {
          this.pendingSandbox.delete(data.commandId);
          this.companions.get(key)?.pendingSandboxIds.delete(data.commandId);
          clearTimeout(pending.timer);
          pending.resolve({
            stdout: data.stdout,
            stderr: data.stderr,
            exitCode: data.exitCode,
            ...(data.changedFiles ? { changedFiles: data.changedFiles } : {}),
            ...(data.skippedFiles ? { skippedFiles: data.skippedFiles } : {}),
          });
        }
        return;
      }

      if (data.type === "sandboxDestroyed") {
        const pending = this.pendingSandbox.get(data.sandboxId);
        if (pending) {
          this.pendingSandbox.delete(data.sandboxId);
          this.companions.get(key)?.pendingSandboxIds.delete(data.sandboxId);
          clearTimeout(pending.timer);
          pending.resolve(undefined);
        }
        return;
      }

      if (data.type === "sandboxError") {
        // Try commandId first, then sandboxId
        const errKey = data.commandId ?? data.sandboxId;
        const pending = this.pendingSandbox.get(errKey);
        if (pending) {
          this.pendingSandbox.delete(errKey);
          this.companions.get(key)?.pendingSandboxIds.delete(errKey);
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

      // Reject only this connection's pending commands so other users aren't affected
      for (const id of conn.pendingCommandIds) {
        const pending = this.pending.get(id);
        if (pending) {
          clearTimeout(pending.timer);
          pending.reject(new Error("Browser companion disconnected"));
          this.pending.delete(id);
        }
      }
      for (const id of conn.pendingSessionIds) {
        const pending = this.pendingSessions.get(id);
        if (pending) {
          clearTimeout(pending.timer);
          pending.reject(new Error("Browser companion disconnected"));
          this.pendingSessions.delete(id);
        }
      }
      for (const id of conn.pendingSandboxIds) {
        const pending = this.pendingSandbox.get(id);
        if (pending) {
          clearTimeout(pending.timer);
          pending.reject(new Error("Browser companion disconnected"));
          this.pendingSandbox.delete(id);
        }
      }
      for (const id of conn.pendingWebAuthnIds) {
        const pending = this.pendingWebAuthn.get(id);
        if (pending) {
          clearTimeout(pending.timer);
          pending.reject(new Error("Browser companion disconnected"));
          this.pendingWebAuthn.delete(id);
        }
      }
    }
  }

  async execute(userId: string, projectId: string, action: BrowserAction, sessionId?: string): Promise<BrowserResult> {
    const key = connKey(userId, projectId);
    const conn = this.companions.get(key);
    if (!conn) {
      throw new Error("Browser companion is not connected. Please start the companion agent on your machine.");
    }

    const id = nanoid();
    const command: BrowserCommand = { id, action, sessionId };

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

  async createSession(userId: string, projectId: string, sessionId: string): Promise<void> {
    const key = connKey(userId, projectId);
    const conn = this.companions.get(key);
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

      const msg: CompanionControl = { type: "createSession", sessionId };
      conn.ws.send(JSON.stringify(msg));
    });
  }

  async destroySession(userId: string, projectId: string, sessionId: string): Promise<void> {
    const key = connKey(userId, projectId);
    const conn = this.companions.get(key);
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

  // ── Sandbox Methods ──

  async createSandbox(userId: string, projectId: string, sandboxId: string): Promise<{ pythonVersion: string | null }> {
    const key = connKey(userId, projectId);
    const conn = this.companions.get(key);
    if (!conn) throw new Error("Browser companion is not connected.");

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingSandbox.delete(sandboxId);
        conn.pendingSandboxIds.delete(sandboxId);
        reject(new Error("Sandbox creation timed out"));
      }, 30_000);

      this.pendingSandbox.set(sandboxId, { resolve, reject, timer });
      conn.pendingSandboxIds.add(sandboxId);
      const msg: CompanionControl = { type: "createSandbox", sandboxId };
      conn.ws.send(JSON.stringify(msg));
    });
  }

  async runScript(
    userId: string,
    projectId: string,
    sandboxId: string,
    script: string,
    packages?: string[],
    timeout?: number,
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
    changedFiles?: Array<{ path: string; data: string; sizeBytes: number }>;
    skippedFiles?: Array<{ path: string; reason: string }>;
  }> {
    const key = connKey(userId, projectId);
    const conn = this.companions.get(key);
    if (!conn) throw new Error("Browser companion is not connected.");

    const commandId = nanoid();
    const bridgeTimeout = (timeout ?? 60_000) + 10_000; // extra buffer for snapshot diff

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingSandbox.delete(commandId);
        conn.pendingSandboxIds.delete(commandId);
        reject(new Error(`Script execution timed out after ${bridgeTimeout / 1000}s`));
      }, bridgeTimeout);

      this.pendingSandbox.set(commandId, { resolve, reject, timer });
      conn.pendingSandboxIds.add(commandId);
      const msg: CompanionControl = { type: "runScript", sandboxId, commandId, script, packages, timeout };
      conn.ws.send(JSON.stringify(msg));
    });
  }

  async destroySandbox(userId: string, projectId: string, sandboxId: string): Promise<void> {
    const key = connKey(userId, projectId);
    const conn = this.companions.get(key);
    if (!conn) return;

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingSandbox.delete(sandboxId);
        conn.pendingSandboxIds.delete(sandboxId);
        resolve(); // Best-effort
      }, 30_000);

      this.pendingSandbox.set(sandboxId, { resolve, reject: () => resolve(), timer });
      conn.pendingSandboxIds.add(sandboxId);
      const msg: CompanionControl = { type: "destroySandbox", sandboxId };
      conn.ws.send(JSON.stringify(msg));
    });
  }

  async sendWebAuthnCommand(userId: string, projectId: string, subCommand: WebAuthnSubCommand): Promise<unknown> {
    const key = connKey(userId, projectId);
    const conn = this.companions.get(key);
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
    const key = connKey(userId, projectId);
    const conn = this.companions.get(key);
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

  isConnected(userId: string, projectId: string): boolean {
    return this.companions.has(connKey(userId, projectId));
  }

  getStatus(userId: string, projectId: string): CompanionStatus {
    const conn = this.companions.get(connKey(userId, projectId));
    if (!conn) return { connected: false };
    return { ...conn.status };
  }

  /** Find any connected companion for a project (any member). */
  findConnectedMember(projectId: string, memberUserIds: string[]): string | undefined {
    for (const userId of memberUserIds) {
      if (this.companions.has(connKey(userId, projectId))) {
        return userId;
      }
    }
    return undefined;
  }
}

export const browserBridge = new BrowserBridge();
