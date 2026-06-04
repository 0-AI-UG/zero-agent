/**
 * Companion connection registry — the server side of the laptop companion's
 * control tunnel.
 *
 * A user runs `zero browser connect` (or `zero companion`) on their machine.
 * That process opens an authenticated WebSocket to `/ws/companion` and speaks
 * the protocol in `@/lib/browser/protocol.ts`: the server sends
 * `CompanionControl` frames, the companion replies with `CompanionMessage`
 * frames. This registry tracks the live connection per USER and exposes a
 * request/response `executeBrowser` that the browser pool calls when a
 * user-initiated turn drives the browser — so the agent drives the user's
 * real local browser instead of the container's headless chromium.
 *
 * One companion per user (a new connection replaces, and closes, any prior
 * one). The connection is tagged with the single project it authorized for;
 * the override only applies to that project (`isConnectedFor`).
 */
import { WebSocket } from "ws";
import { log } from "@/lib/utils/logger.ts";
import type {
  BrowserAction,
  BrowserResult,
  CompanionControl,
  CompanionMessage,
} from "@/lib/browser/protocol.ts";

const companionLog = log.child({ module: "companion-registry" });

/** How long a single browser command may run on the companion before we give up. */
const COMMAND_TIMEOUT_MS = 90_000;
/** Liveness ping cadence; a companion that misses two is dropped. */
const PING_INTERVAL_MS = 30_000;

export interface CompanionCapabilities {
  dockerInstalled: boolean;
  dockerRunning: boolean;
  chromeAvailable: boolean;
}

interface Pending {
  resolve: (r: BrowserResult) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface CompanionConn {
  ws: WebSocket;
  userId: string;
  /** The single project this companion authorized for (the token's binding). */
  projectId: string;
  /**
   * Stable identifier for the computer this connection came from (the runner's
   * `~/.zero/device-id`). Null for older clients that don't send it. Used to
   * tell a same-computer hand-off from a cross-computer takeover when a newer
   * connection displaces this one.
   */
  deviceId: string | null;
  capabilities: CompanionCapabilities | null;
  pending: Map<string, Pending>;
  isAlive: boolean;
  connectedAt: number;
}

class CompanionRegistry {
  private byUser = new Map<string, CompanionConn>();
  private seq = 0;
  private pinger: ReturnType<typeof setInterval> | null = null;

  /** True when a user has a live companion that can drive a browser. */
  isConnected(userId: string): boolean {
    const conn = this.byUser.get(userId);
    return !!conn && conn.ws.readyState === WebSocket.OPEN;
  }

  /**
   * True when a user has a live companion bound to `projectId`. The override
   * only fires for the project the companion authorized for.
   */
  isConnectedFor(userId: string, projectId: string): boolean {
    const conn = this.byUser.get(userId);
    return (
      !!conn &&
      conn.projectId === projectId &&
      conn.ws.readyState === WebSocket.OPEN
    );
  }

  capabilities(userId: string): CompanionCapabilities | null {
    return this.byUser.get(userId)?.capabilities ?? null;
  }

  /**
   * Register a freshly authenticated companion socket for a user. Any existing
   * companion for that user is closed first (last writer wins) — a user has at
   * most one live companion across all projects.
   *
   * The displaced connection is closed with a reason that tells the runner how
   * to react: a takeover from a DIFFERENT computer ("replaced") warns the user,
   * while a hand-off from the SAME computer ("superseded", matching deviceId)
   * steps aside quietly. Either way the old runner stops rather than fighting
   * to reconnect.
   */
  register(ws: WebSocket, userId: string, projectId: string, deviceId: string | null): void {
    const existing = this.byUser.get(userId);
    if (existing && existing.ws !== ws) {
      const sameDevice = deviceId !== null && existing.deviceId === deviceId;
      if (sameDevice) {
        companionLog.info("superseding companion from same device", { userId, deviceId });
        this.teardown(existing, "superseded by a new connection from this device");
      } else {
        companionLog.info("replacing existing companion", { userId });
        this.teardown(existing, "replaced by a newer connection");
      }
    }

    const conn: CompanionConn = {
      ws,
      userId,
      projectId,
      deviceId,
      capabilities: null,
      pending: new Map(),
      isAlive: true,
      connectedAt: Date.now(),
    };
    this.byUser.set(userId, conn);
    this.ensurePinger();

    ws.on("message", (data) => {
      let msg: CompanionMessage;
      try {
        msg = JSON.parse(String(data)) as CompanionMessage;
      } catch {
        companionLog.warn("invalid companion frame", { userId });
        return;
      }
      this.handleMessage(conn, msg);
    });
    ws.on("pong", () => {
      conn.isAlive = true;
    });
    ws.on("close", () => {
      if (this.byUser.get(userId) === conn) {
        this.byUser.delete(userId);
      }
      this.failAllPending(conn, "companion disconnected");
      companionLog.info("companion disconnected", { userId });
    });
    ws.on("error", (err) => {
      companionLog.warn("companion socket error", { userId, err: err.message });
    });

    companionLog.info("companion connected", { userId, projectId });
  }

  /**
   * Drive one browser action on the user's companion. Rejects if no companion
   * is attached, on timeout, or if the companion reports an error.
   */
  executeBrowser(userId: string, action: BrowserAction): Promise<BrowserResult> {
    const conn = this.byUser.get(userId);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("No companion connected for this user"));
    }
    const id = `c${++this.seq}`;
    const control: CompanionControl = { type: "command", command: { id, action } };

    return new Promise<BrowserResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        reject(new Error(`Companion command timed out after ${COMMAND_TIMEOUT_MS}ms`));
      }, COMMAND_TIMEOUT_MS);
      conn.pending.set(id, { resolve, reject, timer });
      try {
        conn.ws.send(JSON.stringify(control));
      } catch (err) {
        conn.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Force-disconnect a user's companion (e.g. when their token is revoked). */
  disconnect(userId: string): void {
    const conn = this.byUser.get(userId);
    if (conn) this.teardown(conn, "disconnected by request");
  }

  private handleMessage(conn: CompanionConn, msg: CompanionMessage): void {
    switch (msg.type) {
      case "pong":
        conn.isAlive = true;
        break;
      case "status":
        if (msg.capabilities) conn.capabilities = msg.capabilities;
        break;
      case "response": {
        const { id, result, error } = msg.response;
        const pending = conn.pending.get(id);
        if (!pending) return;
        conn.pending.delete(id);
        clearTimeout(pending.timer);
        if (error) pending.reject(new Error(error));
        else if (result) pending.resolve(result);
        else pending.reject(new Error("Companion returned an empty result"));
        break;
      }
      default:
        // workspace/* and webauthn/* messages are handled by future modules.
        break;
    }
  }

  private failAllPending(conn: CompanionConn, reason: string): void {
    for (const [, pending] of conn.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    conn.pending.clear();
  }

  private teardown(conn: CompanionConn, reason: string): void {
    if (this.byUser.get(conn.userId) === conn) {
      this.byUser.delete(conn.userId);
    }
    this.failAllPending(conn, reason);
    try {
      conn.ws.close(1000, reason);
    } catch {
      // ignore
    }
  }

  private ensurePinger(): void {
    if (this.pinger) return;
    this.pinger = setInterval(() => {
      for (const conn of this.byUser.values()) {
        if (!conn.isAlive) {
          companionLog.info("companion failed liveness, terminating", { userId: conn.userId });
          try {
            conn.ws.terminate();
          } catch {
            // ignore
          }
          continue;
        }
        conn.isAlive = false;
        try {
          conn.ws.ping();
          conn.ws.send(JSON.stringify({ type: "ping" } satisfies CompanionControl));
        } catch {
          // ignore
        }
      }
    }, PING_INTERVAL_MS);
    if (typeof this.pinger.unref === "function") this.pinger.unref();
  }
}

let registry: CompanionRegistry | null = null;

export function getCompanionRegistry(): CompanionRegistry {
  if (!registry) registry = new CompanionRegistry();
  return registry;
}
