import { CdpClient } from "./cdp.ts";
import type { CompanionControl, CompanionMessage, BrowserResponse, WebAuthnSubCommand } from "./protocol.ts";
import { executeAction, type RefMap } from "./actions.ts";
import { WorkspaceManager } from "./workspace.ts";
import { runCodeInWorker } from "./worker-runner.ts";
import { enableDomainsStealthy } from "./stealth.ts";
import type { Logger } from "./logger.ts";

const RECONNECT_BASE = 1000;
const RECONNECT_MAX = 30000;
// If we don't receive a ping from the server within this window, assume connection is dead
const SERVER_PING_TIMEOUT = 30_000;

const MAX_SESSIONS = 8;
const SESSION_IDLE_TIMEOUT = 5 * 60 * 1000; // 5 minutes

interface SessionState {
  cdp: CdpClient;
  targetId: string;
  refMap: RefMap;
  lastUsedAt: number;
}

interface WsClientOptions {
  serverUrl: string;
  token: string;
  logger: Logger;
  getCdp: () => CdpClient;
  getDefaultRefMap: () => RefMap;
  cdpPort: number;
  onConnected?: () => void;
  onDisconnected?: () => void;
}

export function createWsClient(options: WsClientOptions) {
  let ws: WebSocket | null = null;
  let reconnectDelay = RECONNECT_BASE;
  let stopped = false;
  let serverPingTimer: ReturnType<typeof setTimeout> | null = null;
  const sessions = new Map<string, SessionState>();
  const workspaceManager = new WorkspaceManager({
    logger: options.logger,
    backend: {
      async initWorkspace() {},
      async runCommand(_workspaceId, dir, command, timeout) {
        // Command is encoded as "entrypoint:<path>" or raw code
        if (command.startsWith("entrypoint:")) {
          const entrypoint = command.slice("entrypoint:".length);
          return runCodeInWorker(null, dir, timeout, entrypoint);
        }
        return runCodeInWorker(command, dir, timeout);
      },
      async destroyWorkspace() {},
    },
  });

  // Session idle reaper — runs every 60s, cleans up sessions idle for 5+ min
  const sessionReaper = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastUsedAt > SESSION_IDLE_TIMEOUT) {
        console.log(`Reaping idle session ${id}`);
        destroySessionInternal(id, session);
      }
    }
  }, 60_000);

  async function createSessionInternal(sessionId: string): Promise<void> {
    if (sessions.size >= MAX_SESSIONS) {
      throw new Error(`Session limit reached (max ${MAX_SESSIONS})`);
    }
    if (sessions.has(sessionId)) {
      return; // Already exists
    }

    // Create a new tab
    const res = await fetch(`http://127.0.0.1:${options.cdpPort}/json/new?about:blank`, { method: "PUT" });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`CDP /json/new failed (${res.status}): ${body.slice(0, 200)}`);
    }
    const target = (await res.json()) as { id: string; webSocketDebuggerUrl: string };

    const cdp = new CdpClient(target.webSocketDebuggerUrl);
    await cdp.connect();

    // Enable required domains with stealth measures
    await enableDomainsStealthy(cdp);

    sessions.set(sessionId, {
      cdp,
      targetId: target.id,
      refMap: new Map(),
      lastUsedAt: Date.now(),
    });
  }

  function destroySessionInternal(sessionId: string, session?: SessionState): void {
    const s = session ?? sessions.get(sessionId);
    if (!s) return;
    sessions.delete(sessionId);
    s.cdp.close();
    // Close the tab
    fetch(`http://127.0.0.1:${options.cdpPort}/json/close/${s.targetId}`).catch(() => {});
  }

  function destroyAllSessions(): void {
    for (const [id, session] of sessions) {
      destroySessionInternal(id, session);
    }
  }

  function resetServerPingTimer() {
    if (serverPingTimer) clearTimeout(serverPingTimer);
    serverPingTimer = setTimeout(() => {
      console.log("No ping from server, connection may be dead. Reconnecting...");
      ws?.close();
    }, SERVER_PING_TIMEOUT);
  }

  function clearServerPingTimer() {
    if (serverPingTimer) {
      clearTimeout(serverPingTimer);
      serverPingTimer = null;
    }
  }

  async function handleServerMessage(data: CompanionControl) {
    if (data.type === "ping") {
      resetServerPingTimer();
      const pong: CompanionMessage = { type: "pong" };
      ws?.send(JSON.stringify(pong));
      return;
    }

    if (data.type === "createSession") {
      try {
        await createSessionInternal(data.sessionId);
        const msg: CompanionMessage = { type: "sessionCreated", sessionId: data.sessionId };
        ws?.send(JSON.stringify(msg));
      } catch (err) {
        const msg: CompanionMessage = {
          type: "sessionError",
          sessionId: data.sessionId,
          error: err instanceof Error ? err.message : String(err),
        };
        ws?.send(JSON.stringify(msg));
      }
      return;
    }

    if (data.type === "destroySession") {
      destroySessionInternal(data.sessionId);
      const msg: CompanionMessage = { type: "sessionDestroyed", sessionId: data.sessionId };
      ws?.send(JSON.stringify(msg));
      return;
    }

    // ── WebAuthn handlers ──

    if (data.type === "webauthn") {
      const { subCommand } = data;
      const cdp = options.getCdp();
      (async () => {
        try {
          let result: unknown;
          switch (subCommand.type) {
            case "enable":
              result = await cdp.send("WebAuthn.enable");
              break;
            case "addAuthenticator":
              result = await cdp.send("WebAuthn.addVirtualAuthenticator", {
                options: subCommand.options,
              });
              break;
            case "addCredential":
              result = await cdp.send("WebAuthn.addCredential", {
                authenticatorId: subCommand.authenticatorId,
                credential: subCommand.credential,
              });
              break;
            case "getCredentials":
              result = await cdp.send("WebAuthn.getCredentials", {
                authenticatorId: subCommand.authenticatorId,
              });
              break;
            case "removeAuthenticator":
              result = await cdp.send("WebAuthn.removeVirtualAuthenticator", {
                authenticatorId: subCommand.authenticatorId,
              });
              break;
          }
          ws?.send(JSON.stringify({ type: "webauthnResult", commandId: subCommand.commandId, result }));
        } catch (err) {
          ws?.send(JSON.stringify({ type: "webauthnError", commandId: subCommand.commandId,
            error: err instanceof Error ? err.message : String(err) }));
        }
      })();
      return;
    }

    // ── Workspace handlers ──

    if (data.type === "createWorkspace") {
      workspaceManager.createWorkspace(data.workspaceId, data.manifest).then(() => {
        const msg: CompanionMessage = { type: "workspaceCreated", workspaceId: data.workspaceId };
        ws?.send(JSON.stringify(msg));
      }).catch((err) => {
        const msg: CompanionMessage = { type: "workspaceError", workspaceId: data.workspaceId, error: err instanceof Error ? err.message : String(err) };
        ws?.send(JSON.stringify(msg));
      });
      return;
    }

    if (data.type === "syncWorkspace") {
      workspaceManager.syncWorkspace(data.workspaceId, data.manifest).then(() => {
        const msg: CompanionMessage = { type: "workspaceSynced", workspaceId: data.workspaceId };
        ws?.send(JSON.stringify(msg));
      }).catch((err) => {
        const msg: CompanionMessage = { type: "workspaceError", workspaceId: data.workspaceId, error: err instanceof Error ? err.message : String(err) };
        ws?.send(JSON.stringify(msg));
      });
      return;
    }

    if (data.type === "runCode") {
      const command = data.entrypoint ? `entrypoint:${data.entrypoint}` : (data.code ?? "");
      workspaceManager.runCommand(data.workspaceId, command, data.timeout).then((result) => {
        const msg: CompanionMessage = { type: "commandResult", commandId: data.commandId, workspaceId: data.workspaceId, ...result };
        ws?.send(JSON.stringify(msg));
      }).catch((err) => {
        const msg: CompanionMessage = { type: "workspaceError", workspaceId: data.workspaceId, commandId: data.commandId, error: err instanceof Error ? err.message : String(err) };
        ws?.send(JSON.stringify(msg));
      });
      return;
    }

    if (data.type === "destroyWorkspace") {
      workspaceManager.destroyWorkspace(data.workspaceId).then(() => {
        const msg: CompanionMessage = { type: "workspaceDestroyed", workspaceId: data.workspaceId };
        ws?.send(JSON.stringify(msg));
      }).catch((err) => {
        const msg: CompanionMessage = { type: "workspaceError", workspaceId: data.workspaceId, error: err instanceof Error ? err.message : String(err) };
        ws?.send(JSON.stringify(msg));
      });
      return;
    }

    if (data.type === "command") {
      const { command } = data;

      // Route to session or default CDP
      const session = command.sessionId ? sessions.get(command.sessionId) : null;
      const getCdp = session ? () => session.cdp : options.getCdp;
      const refMap = session ? session.refMap : options.getDefaultRefMap();

      if (session) session.lastUsedAt = Date.now();

      if (command.sessionId && !session) {
        const response: BrowserResponse = {
          id: command.id,
          error: `Session ${command.sessionId} not found. Create it first with createSession.`,
        };
        const msg: CompanionMessage = { type: "response", response };
        ws?.send(JSON.stringify(msg));
        return;
      }

      let response: BrowserResponse;
      try {
        const cdp = getCdp();
        const result = await executeAction(cdp, command.action, options.cdpPort, refMap);
        response = { id: command.id, result };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);

        // If Chrome is reconnecting, wait briefly and retry once
        if (errMsg.includes("not connected") || errMsg.includes("crashed") || errMsg.includes("closed")) {
          console.log(`Chrome unavailable for command ${command.id}, retrying in 3s...`);
          await new Promise((r) => setTimeout(r, 3000));
          try {
            const cdp = getCdp();
            const result = await executeAction(cdp, command.action, options.cdpPort, refMap);
            response = { id: command.id, result };
          } catch (retryErr) {
            response = {
              id: command.id,
              error: retryErr instanceof Error ? retryErr.message : String(retryErr),
            };
          }
        } else {
          response = { id: command.id, error: errMsg };
        }
      }

      const msg: CompanionMessage = { type: "response", response };
      ws?.send(JSON.stringify(msg));
    }
  }

  function connect() {
    if (stopped) return;

    // Convert http(s):// to ws(s):// for WebSocket connection
    const wsBase = options.serverUrl
      .replace(/^http:\/\//, "ws://")
      .replace(/^https:\/\//, "wss://");
    const url = `${wsBase}/ws/companion`;
    console.log(`Connecting to server...`);

    ws = new WebSocket(url);
    let authenticated = false;

    ws.onopen = () => {
      // Send auth token as the first message (not in URL to avoid log exposure)
      ws!.send(JSON.stringify({ type: "auth", token: options.token }));
    };

    ws.onmessage = async (event) => {
      try {
        const data = JSON.parse(
          typeof event.data === "string" ? event.data : event.data.toString(),
        );

        // Handle auth response before treating connection as established
        if (!authenticated) {
          if (data.type === "auth_ok") {
            authenticated = true;
            console.log("Connected and authenticated");
            reconnectDelay = RECONNECT_BASE;
            resetServerPingTimer();
            options.onConnected?.();

            // Send initial status
            try {
              const cdp = options.getCdp();
              const result = await cdp.send("Runtime.evaluate", {
                expression: "location.href",
                returnByValue: true,
              });
              const msg: CompanionMessage = {
                type: "status",
                url: result.result?.value ?? "about:blank",
              };
              ws!.send(JSON.stringify(msg));
            } catch {
              const msg: CompanionMessage = { type: "status" };
              ws!.send(JSON.stringify(msg));
            }
            return;
          }
          if (data.type === "error") {
            console.error("Authentication failed:", data.error);
            ws?.close();
            return;
          }
          return; // Ignore other messages before auth
        }

        await handleServerMessage(data as CompanionControl);
      } catch (err) {
        console.error("Failed to handle message:", err);
      }
    };

    ws.onclose = () => {
      ws = null;
      clearServerPingTimer();
      options.onDisconnected?.();
      if (!stopped) {
        console.log(`Disconnected. Reconnecting in ${reconnectDelay / 1000}s...`);
        setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX);
      }
    };

    ws.onerror = (err) => {
      console.error("WebSocket error:", err);
      ws?.close();
    };
  }

  function stop() {
    stopped = true;
    clearInterval(sessionReaper);
    destroyAllSessions();
    workspaceManager.stop();
    ws?.close();
  }

  connect();

  return { stop };
}
