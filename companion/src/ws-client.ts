import * as path from "node:path";
import { CdpClient } from "./cdp.ts";
import type { CompanionControl, CompanionMessage, BrowserResponse, WebAuthnSubCommand } from "./protocol.ts";
import { executeAction, type RefMap } from "./actions.ts";
import { WorkspaceManager } from "./workspace.ts";
import { ContainerBackend, detectRuntime, prepareRuntime } from "./container-backend.ts";
import { enableDomainsStealthy } from "./stealth.ts";
import type { Logger } from "./logger.ts";
import type { ActivityEvent } from "./shared/rpc.ts";

const RECONNECT_BASE = 1000;
const RECONNECT_MAX = 30000;
// If we don't receive a ping from the server within this window, assume connection is dead
const SERVER_PING_TIMEOUT = 30_000;

const MAX_SESSIONS = 8;
const SESSION_IDLE_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const CHAT_SESSION_IDLE_TIMEOUT = 15 * 60 * 1000; // 15 minutes for chat sessions

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
  onEvent?: (event: ActivityEvent) => void;
}

export async function createWsClient(options: WsClientOptions) {
  let ws: WebSocket | null = null;
  let reconnectDelay = RECONNECT_BASE;
  let stopped = false;
  let serverPingTimer: ReturnType<typeof setTimeout> | null = null;
  const sessions = new Map<string, SessionState>();
  const sessionInfo = new Map<string, { url?: string; title?: string; label?: string }>();
  const workspaceFiles = new Map<string, string[]>();
  const workspaceStatuses = new Map<string, string>();

  /** Safely emit an event — never throw to avoid breaking message handling chains. */
  function emitEvent(event: ActivityEvent) {
    try {
      options.onEvent?.(event);
    } catch (err) {
      console.error("Failed to emit event:", err, event);
    }
  }
  // Detect container runtime — don't crash if Docker is missing
  let dockerInstalled = false;
  let dockerRunning = false;
  let workspaceManager: WorkspaceManager | null = null;

  async function initDocker() {
    const runtimeStatus = detectRuntime();
    if (!runtimeStatus.ready) {
      dockerInstalled = runtimeStatus.installed;
      dockerRunning = false;
      if (dockerInstalled) {
        options.logger.warn("Docker is installed but not running. Code execution will be unavailable.");
      } else {
        options.logger.warn("Docker is not installed. Code execution will be unavailable.");
      }
      return;
    }
    try {
      await prepareRuntime();
      workspaceManager = new WorkspaceManager({
        logger: options.logger,
        backend: new ContainerBackend(),
      });
      dockerInstalled = true;
      dockerRunning = true;
      options.logger.info("Using Docker");
    } catch (err) {
      options.logger.warn(`Docker preparation failed: ${err instanceof Error ? err.message : String(err)}`);
      dockerInstalled = true;
      dockerRunning = false;
    }
  }

  await initDocker();

  // Periodically re-check Docker availability (every 30s)
  const dockerCheckInterval = setInterval(async () => {
    if (dockerRunning && workspaceManager) return; // Already ready
    const prevInstalled = dockerInstalled;
    const prevRunning = dockerRunning;
    const status = detectRuntime();
    if (status.ready && !workspaceManager) {
      options.logger.info("Docker is now available, initializing...");
      await initDocker();
      sendCapabilities();
    } else if (!status.ready) {
      dockerInstalled = status.installed;
      dockerRunning = false;
      // Send update if status changed
      if (dockerInstalled !== prevInstalled || dockerRunning !== prevRunning) {
        sendCapabilities();
      }
    }
  }, 30_000);

  function sendCapabilities() {
    if (!ws) return;
    const msg: CompanionMessage = {
      type: "status",
      capabilities: { dockerInstalled, dockerRunning, chromeAvailable: true },
    };
    ws.send(JSON.stringify(msg));
  }

  // Session idle reaper — runs every 60s, cleans up sessions idle for 5+ min
  const sessionReaper = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      const timeout = id.startsWith("chat-") ? CHAT_SESSION_IDLE_TIMEOUT : SESSION_IDLE_TIMEOUT;
      if (now - session.lastUsedAt > timeout) {
        console.log(`Reaping idle session ${id}`);
        destroySessionInternal(id, session);
      }
    }
  }, 60_000);

  async function createSessionInternal(sessionId: string, label?: string): Promise<void> {
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
    emitEvent({ type: "session:created", sessionId, label });
    sessionInfo.set(sessionId, { label });
  }

  function destroySessionInternal(sessionId: string, session?: SessionState): void {
    const s = session ?? sessions.get(sessionId);
    if (!s) return;
    sessions.delete(sessionId);
    sessionInfo.delete(sessionId);
    emitEvent({ type: "session:destroyed", sessionId });
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
        await createSessionInternal(data.sessionId, data.label);
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
      if (!workspaceManager) {
        const msg: CompanionMessage = { type: "workspaceError", workspaceId: data.workspaceId, error: "Docker is not running. Install and start Docker to enable code execution." };
        ws?.send(JSON.stringify(msg));
        return;
      }
      workspaceManager.createWorkspace(data.workspaceId, data.manifest).then(() => {
        emitEvent({ type: "workspace:created", workspaceId: data.workspaceId });
        emitEvent({ type: "workspace:files", workspaceId: data.workspaceId, files: Object.keys(data.manifest) });
        workspaceFiles.set(data.workspaceId, Object.keys(data.manifest));
        workspaceStatuses.set(data.workspaceId, "ready");
        const msg: CompanionMessage = { type: "workspaceCreated", workspaceId: data.workspaceId };
        ws?.send(JSON.stringify(msg));
      }).catch((err) => {
        emitEvent({ type: "workspace:error", workspaceId: data.workspaceId, error: err instanceof Error ? err.message : String(err) });
        const msg: CompanionMessage = { type: "workspaceError", workspaceId: data.workspaceId, error: err instanceof Error ? err.message : String(err) };
        ws?.send(JSON.stringify(msg));
      });
      return;
    }

    if (data.type === "syncWorkspace") {
      if (!workspaceManager) {
        const msg: CompanionMessage = { type: "workspaceError", workspaceId: data.workspaceId, error: "Docker is not running. Install and start Docker to enable code execution." };
        ws?.send(JSON.stringify(msg));
        return;
      }
      workspaceManager.syncWorkspace(data.workspaceId, data.manifest).then(() => {
        emitEvent({ type: "workspace:files", workspaceId: data.workspaceId, files: Object.keys(data.manifest) });
        workspaceFiles.set(data.workspaceId, Object.keys(data.manifest));
        const msg: CompanionMessage = { type: "workspaceSynced", workspaceId: data.workspaceId };
        ws?.send(JSON.stringify(msg));
      }).catch((err) => {
        const msg: CompanionMessage = { type: "workspaceError", workspaceId: data.workspaceId, error: err instanceof Error ? err.message : String(err) };
        ws?.send(JSON.stringify(msg));
      });
      return;
    }

    if (data.type === "runBash") {
      if (!workspaceManager) {
        const msg: CompanionMessage = { type: "workspaceError", workspaceId: data.workspaceId, commandId: data.commandId, error: "Docker is not running. Install and start Docker to enable code execution." };
        ws?.send(JSON.stringify(msg));
        return;
      }
      emitEvent({ type: "workspace:bash-started", workspaceId: data.workspaceId, command: data.command });
      emitEvent({ type: "workspace:running", workspaceId: data.workspaceId });
      workspaceStatuses.set(data.workspaceId, "running");
      workspaceManager.runCommand(data.workspaceId, data.command, data.timeout).then((result) => {
        const MAX_OUTPUT = 10_240;
        const truncated = result.stdout.length > MAX_OUTPUT || result.stderr.length > MAX_OUTPUT;
        emitEvent({
          type: "workspace:bash-result",
          workspaceId: data.workspaceId,
          stdout: result.stdout.slice(0, MAX_OUTPUT),
          stderr: result.stderr.slice(0, MAX_OUTPUT),
          exitCode: result.exitCode,
          changedFiles: result.changedFiles?.map((f: { path: string; sizeBytes: number }) => ({ path: f.path, sizeBytes: f.sizeBytes })),
          deletedFiles: result.deletedFiles,
          truncated,
        });
        emitEvent({ type: "workspace:completed", workspaceId: data.workspaceId, exitCode: result.exitCode });
        workspaceStatuses.set(data.workspaceId, "ready");
        const msg: CompanionMessage = { type: "bashResult", commandId: data.commandId, workspaceId: data.workspaceId, ...result };
        ws?.send(JSON.stringify(msg));
      }).catch((err) => {
        emitEvent({ type: "workspace:error", workspaceId: data.workspaceId, error: err instanceof Error ? err.message : String(err) });
        workspaceStatuses.set(data.workspaceId, "error");
        const msg: CompanionMessage = { type: "workspaceError", workspaceId: data.workspaceId, commandId: data.commandId, error: err instanceof Error ? err.message : String(err) };
        ws?.send(JSON.stringify(msg));
      });
      return;
    }

    if (data.type === "destroyWorkspace") {
      if (!workspaceManager) {
        const msg: CompanionMessage = { type: "workspaceDestroyed", workspaceId: data.workspaceId };
        ws?.send(JSON.stringify(msg));
        return;
      }
      workspaceManager.destroyWorkspace(data.workspaceId).then(() => {
        emitEvent({ type: "workspace:destroyed", workspaceId: data.workspaceId });
        workspaceFiles.delete(data.workspaceId);
        workspaceStatuses.delete(data.workspaceId);
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

      // All browser commands must target an explicit session
      if (!command.sessionId) {
        const response: BrowserResponse = {
          id: command.id,
          error: "No sessionId provided. Browser commands require an explicit session.",
        };
        const msg: CompanionMessage = { type: "response", response };
        ws?.send(JSON.stringify(msg));
        return;
      }

      // Route to session CDP and refMap
      const session = sessions.get(command.sessionId);
      const getCdp = session ? () => session.cdp : options.getCdp;
      const refMap = session ? session.refMap : options.getDefaultRefMap();

      if (session) session.lastUsedAt = Date.now();

      if (!session) {
        const response: BrowserResponse = {
          id: command.id,
          error: `Session ${command.sessionId} not found. Create it first with createSession.`,
        };
        const msg: CompanionMessage = { type: "response", response };
        ws?.send(JSON.stringify(msg));
        return;
      }

      // Emit browser action event
      const actionDetail = 'url' in command.action ? (command.action as { url: string }).url : undefined;
      emitEvent({ type: "browser:action", sessionId: command.sessionId, action: command.action.type, detail: actionDetail });

      let response: BrowserResponse;
      try {
        const cdp = getCdp();
        const result = await executeAction(cdp, command.action, options.cdpPort, refMap, { stealth: command.stealth });
        response = { id: command.id, result };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);

        // If Chrome is reconnecting, wait briefly and retry once
        if (errMsg.includes("not connected") || errMsg.includes("crashed") || errMsg.includes("closed")) {
          console.log(`Chrome unavailable for command ${command.id}, retrying in 3s...`);
          await new Promise((r) => setTimeout(r, 3000));
          try {
            const cdp = getCdp();
            const result = await executeAction(cdp, command.action, options.cdpPort, refMap, { stealth: command.stealth });
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

      // Emit result event
      if (response.result && 'url' in response.result) {
        const r = response.result as { url: string; title: string };
        emitEvent({ type: "browser:done", sessionId: command.sessionId, url: r.url, title: r.title });
        if (command.sessionId) sessionInfo.set(command.sessionId, { url: r.url, title: r.title });
      }
      if (response.error) {
        emitEvent({ type: "browser:error", sessionId: command.sessionId, error: response.error });
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

            // Send initial status with capabilities
            try {
              const cdp = options.getCdp();
              const result = await cdp.send("Runtime.evaluate", {
                expression: "location.href",
                returnByValue: true,
              });
              const msg: CompanionMessage = {
                type: "status",
                url: result.result?.value ?? "about:blank",
                capabilities: { dockerInstalled, dockerRunning, chromeAvailable: true },
              };
              ws!.send(JSON.stringify(msg));
            } catch {
              const msg: CompanionMessage = {
                type: "status",
                capabilities: { dockerInstalled, dockerRunning, chromeAvailable: true },
              };
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
    clearInterval(dockerCheckInterval);
    destroyAllSessions();
    workspaceManager?.stop();
    ws?.close();
  }

  function getState() {
    return {
      sessions: [...sessionInfo.entries()].map(([id, info]) => ({ id, ...info })),
      workspaces: [...workspaceStatuses.entries()].map(([id, status]) => ({
        id,
        status,
        files: workspaceFiles.get(id) ?? [],
      })),
    };
  }

  connect();

  return { stop, getState };
}
