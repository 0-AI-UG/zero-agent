import { WebSocketServer, WebSocket } from "ws";
import type { Server as HttpServer, IncomingMessage } from "node:http";
import { verifyToken, type TokenPayload } from "@/lib/auth/auth.ts";
import { isProjectMember } from "@/db/queries/members.ts";
import { getUserById } from "@/db/queries/users.ts";
import { getProjectById } from "@/db/queries/projects.ts";
import { getChatById } from "@/db/queries/chats.ts";
import { log } from "@/lib/utils/logger.ts";
import { isChatWsMessage, handleChatMessage } from "@/lib/http/ws-chat.ts";
import { subscribeBrowser, unsubscribeBrowser } from "@/lib/http/ws-browser.ts";
import type { PiEventEnvelope } from "@/lib/pi/run-turn.ts";
import {
  applyPiEvent,
  beginStreaming,
  createChatState,
  endStreaming,
  hydrateChatState,
  serializeState,
  type ChatState,
} from "@/lib/http/chat-state.ts";

const wsLog = log.child({ module: "ws" });

// ── Types ──

interface ConnectionMeta {
  userId: string;
  username: string;
  projectId: string | null;
  chatId: string | null;
  connectedAt: number;
  isAlive: boolean;
}

export interface WsBroadcastMessage {
  type: string;
  [key: string]: unknown;
}

// ── State ──

const connections = new Map<WebSocket, ConnectionMeta>();
const projectRooms = new Map<string, Set<WebSocket>>();
const chatViewers = new Map<string, Set<WebSocket>>();

// ── Chat state ──
//
// Per-chat in-memory state. Pi owns the canonical transcript on disk
// (`<project>/.pi-sessions/<chatId>.jsonl`). The scene here is the
// hydrated transcript plus live executions and streaming flag — the
// single source of truth we serialize and broadcast as `chat.state`.

const WS_BUFFER_HIGH_WATER = 1 * 1024 * 1024; // 1 MB
const WS_FRAME_SIZE_CAP = 4 * 1024 * 1024; // 4 MB

const chatScenes = new Map<string, ChatState>();

const CHAT_SCENE_MAX = 50;
const CHAT_SCENE_IDLE_MS = 60 * 60 * 1000;

function touch(s: ChatState) {
  s.lastAccessAt = Date.now();
}

function resolveProjectId(chatId: string): string | null {
  const chat = getChatById(chatId);
  return chat?.project_id ?? null;
}

function getOrCreateScene(chatId: string): ChatState {
  let s = chatScenes.get(chatId);
  if (s) {
    touch(s);
    return s;
  }
  s = createChatState(chatId, resolveProjectId(chatId));
  chatScenes.set(chatId, s);
  if (chatScenes.size > CHAT_SCENE_MAX) evictChatScenes();
  return s;
}

/** Hydrate from JSONL if not yet hydrated. No-op once loaded. */
function ensureHydrated(s: ChatState): void {
  if (s.hydrated) return;
  const projectId = s.projectId ?? resolveProjectId(s.chatId);
  if (!projectId) {
    s.hydrated = true;
    return;
  }
  hydrateChatState(s, projectId);
}

function evictChatScenes() {
  const now = Date.now();
  const candidates: ChatState[] = [];
  for (const s of chatScenes.values()) {
    if (s.isStreaming) continue;
    if ((chatViewers.get(s.chatId)?.size ?? 0) > 0) continue;
    candidates.push(s);
  }
  candidates.sort((a, b) => a.lastAccessAt - b.lastAccessAt);
  const target = Math.max(0, chatScenes.size - CHAT_SCENE_MAX);
  for (let i = 0; i < target && i < candidates.length; i++) {
    const c = candidates[i];
    if (c) chatScenes.delete(c.chatId);
  }
  for (const s of candidates) {
    if (now - s.lastAccessAt > CHAT_SCENE_IDLE_MS) chatScenes.delete(s.chatId);
  }
}

let chatSceneSweeper: ReturnType<typeof setInterval> | null = null;

function broadcastChatState(s: ChatState): void {
  broadcastToChat(s.chatId, serializeState(s));
}

export function beginChatStream(chatId: string, runId: string): void {
  const s = getOrCreateScene(chatId);
  ensureHydrated(s);
  beginStreaming(s, runId);
  broadcastChatState(s);
}

/** Apply one Pi event to chat state and broadcast the new state. */
export function publishPiEvent(envelope: PiEventEnvelope): void {
  const s = getOrCreateScene(envelope.chatId);
  ensureHydrated(s);
  if (applyPiEvent(s, envelope)) broadcastChatState(s);
}

export function endChatStream(
  chatId: string,
  reason: "completed" | "aborted" | "error",
  error?: string,
): void {
  const s = getOrCreateScene(chatId);
  endStreaming(s, reason, error);
  // Final reconcile from JSONL — Pi's canonical state is the truth.
  const projectId = s.projectId ?? resolveProjectId(s.chatId);
  if (projectId) hydrateChatState(s, projectId);
  broadcastChatState(s);
}

export function isChatStreaming(chatId: string): boolean {
  return chatScenes.get(chatId)?.isStreaming ?? false;
}

let wss: WebSocketServer | null = null;
let attachedServer: HttpServer | null = null;
let upgradeHandler: ((req: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => void) | null = null;

// ── Public API ──

export function attachWebSocketServer(server: HttpServer) {
  wss = new WebSocketServer({ noServer: true });
  attachedServer = server;

  upgradeHandler = async (req, socket, head) => {
    wsLog.info("upgrade request", { url: req.url, headers: req.headers.upgrade });
    if (!wss) {
      socket.destroy();
      return;
    }
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (url.pathname !== "/ws") {
      wsLog.info("upgrade rejected - wrong path", { pathname: url.pathname });
      socket.destroy();
      return;
    }

    const token = url.searchParams.get("token");
    if (!token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    let payload: TokenPayload;
    try {
      payload = await verifyToken(token);
    } catch {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    if (!wss) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss?.emit("connection", ws, req, payload);
    });
  };

  server.on("upgrade", upgradeHandler);

  wss.on("connection", (ws: WebSocket, _req: IncomingMessage, payload: TokenPayload) => {
    const meta: ConnectionMeta = {
      userId: payload.userId,
      username: payload.username,
      projectId: null,
      chatId: null,
      connectedAt: Date.now(),
      isAlive: true,
    };
    connections.set(ws, meta);
    wsLog.info("ws connected", { userId: payload.userId, username: payload.username });

    send(ws, { type: "connected", userId: payload.userId });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(String(data));
        wsLog.debug("ws message received", { userId: meta.userId, type: msg.type });
        handleMessage(ws, meta, msg);
      } catch {
        send(ws, { type: "error", message: "Invalid message" });
      }
    });

    ws.on("pong", () => {
      meta.isAlive = true;
    });

    ws.on("close", () => {
      handleDisconnect(ws, meta);
    });

    ws.on("error", (err) => {
      wsLog.warn("ws error", { userId: meta.userId, error: err.message });
    });
  });

  const pingInterval = setInterval(() => {
    for (const [ws, meta] of connections) {
      if (!meta.isAlive) {
        ws.terminate();
        continue;
      }
      meta.isAlive = false;
      ws.ping();
    }
  }, 30_000);

  chatSceneSweeper = setInterval(evictChatScenes, 5 * 60 * 1000);

  wss.on("close", () => {
    clearInterval(pingInterval);
    if (chatSceneSweeper) clearInterval(chatSceneSweeper);
    chatSceneSweeper = null;
  });

  wsLog.info("websocket server attached");
}

export function shedChatScenes(): number {
  const before = chatScenes.size;
  for (const s of [...chatScenes.values()]) {
    if (s.isStreaming) continue;
    if ((chatViewers.get(s.chatId)?.size ?? 0) > 0) continue;
    chatScenes.delete(s.chatId);
  }
  return before - chatScenes.size;
}

export function chatSceneStats() {
  return { scenes: chatScenes.size, viewers: chatViewers.size, connections: connections.size };
}

export function closeWebSocketServer() {
  if (!wss) return;
  if (attachedServer && upgradeHandler) {
    attachedServer.off("upgrade", upgradeHandler);
  }
  upgradeHandler = null;
  attachedServer = null;
  for (const ws of connections.keys()) {
    ws.close(1001, "Server shutting down");
  }
  wss.close();
  wss = null;
}

export function broadcastToProject(projectId: string, message: WsBroadcastMessage) {
  const room = projectRooms.get(projectId);
  if (!room) return;
  const data = JSON.stringify(message);
  for (const ws of room) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (ws.bufferedAmount > WS_BUFFER_HIGH_WATER) continue;
    ws.send(data);
  }
}

export function broadcastToUser(userId: string, message: WsBroadcastMessage): number {
  const data = JSON.stringify(message);
  let sent = 0;
  for (const [ws, meta] of connections) {
    if (meta.userId !== userId) continue;
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (ws.bufferedAmount > WS_BUFFER_HIGH_WATER) continue;
    ws.send(data);
    sent++;
  }
  return sent;
}

export function isUserConnected(userId: string): boolean {
  for (const meta of connections.values()) {
    if (meta.userId === userId) return true;
  }
  return false;
}

export function broadcastToChat(chatId: string, message: WsBroadcastMessage) {
  const viewers = chatViewers.get(chatId);
  if (!viewers || viewers.size === 0) return;
  const data = JSON.stringify(message);
  if (data.length > WS_FRAME_SIZE_CAP) {
    wsLog.warn("ws frame exceeds size cap, dropping", { chatId, bytes: data.length });
    return;
  }
  for (const ws of viewers) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (ws.bufferedAmount > WS_BUFFER_HIGH_WATER) {
      wsLog.debug("ws backpressure, skipping frame", { chatId, buffered: ws.bufferedAmount });
      continue;
    }
    ws.send(data);
  }
}

export function getPresence(projectId: string): Array<{
  userId: string;
  username: string;
  chatId: string | null;
}> {
  const room = projectRooms.get(projectId);
  if (!room) return [];
  const seen = new Map<string, { userId: string; username: string; chatId: string | null }>();
  for (const ws of room) {
    const meta = connections.get(ws);
    if (!meta) continue;
    const existing = seen.get(meta.userId);
    if (!existing || (!existing.chatId && meta.chatId)) {
      seen.set(meta.userId, { userId: meta.userId, username: meta.username, chatId: meta.chatId });
    }
  }
  return Array.from(seen.values());
}

// ── Message handlers ──

function handleMessage(ws: WebSocket, meta: ConnectionMeta, msg: any) {
  if (isChatWsMessage(msg)) {
    void handleChatMessage(ws, meta, msg);
    return;
  }
  switch (msg.type) {
    case "join":
      handleJoin(ws, meta, msg.projectId);
      break;
    case "viewChat":
      handleViewChat(ws, meta, msg.chatId);
      break;
    case "leaveChat":
      handleLeaveChat(ws, meta);
      break;
    case "typing":
      handleTyping(ws, meta, msg.chatId);
      break;
    case "heartbeat":
      send(ws, { type: "pong" });
      break;
    case "refreshToken":
      handleRefreshToken(ws, meta, msg.token);
      break;
    case "subscribeBrowser":
      if (typeof msg.projectId === "string") {
        if (meta.projectId !== msg.projectId) {
          send(ws, { type: "error", message: "Join project before subscribing to browser" });
          break;
        }
        subscribeBrowser(ws, msg.projectId);
      }
      break;
    case "unsubscribeBrowser":
      unsubscribeBrowser(ws, typeof msg.projectId === "string" ? msg.projectId : undefined);
      break;
  }
}

async function handleJoin(ws: WebSocket, meta: ConnectionMeta, projectId: string) {
  if (!projectId) return;

  const project = getProjectById(projectId);
  if (!project) {
    send(ws, { type: "error", message: "Project not found" });
    return;
  }
  const user = getUserById(meta.userId);
  if (user?.is_admin !== 1 && !isProjectMember(projectId, meta.userId)) {
    send(ws, { type: "error", message: "Not a member of this project" });
    return;
  }

  leaveChat(ws, meta);
  leaveProject(ws, meta);

  meta.projectId = projectId;
  if (!projectRooms.has(projectId)) {
    projectRooms.set(projectId, new Set());
  }
  projectRooms.get(projectId)!.add(ws);

  wsLog.debug("user joined project", { userId: meta.userId, projectId });
  send(ws, { type: "presence", users: getPresence(projectId) });
  broadcastPresence(projectId);
}

function handleViewChat(ws: WebSocket, meta: ConnectionMeta, chatId: string) {
  if (!chatId || !meta.projectId) return;

  leaveChat(ws, meta);

  meta.chatId = chatId;
  if (!chatViewers.has(chatId)) {
    chatViewers.set(chatId, new Set());
  }
  chatViewers.get(chatId)!.add(ws);

  const scene = getOrCreateScene(chatId);
  ensureHydrated(scene);
  send(ws, serializeState(scene));
  broadcastPresence(meta.projectId);
}

function handleLeaveChat(ws: WebSocket, meta: ConnectionMeta) {
  if (!meta.chatId) return;
  leaveChat(ws, meta);
  if (meta.projectId) broadcastPresence(meta.projectId);
}

function leaveChat(ws: WebSocket, meta: ConnectionMeta) {
  if (!meta.chatId) return;
  const viewers = chatViewers.get(meta.chatId);
  viewers?.delete(ws);
  if (viewers && viewers.size === 0) chatViewers.delete(meta.chatId);
  meta.chatId = null;
}

function handleTyping(ws: WebSocket, meta: ConnectionMeta, chatId: string) {
  if (!meta.projectId || !chatId) return;
  const room = projectRooms.get(meta.projectId);
  if (!room) return;
  const data = JSON.stringify({
    type: "userTyping",
    chatId,
    userId: meta.userId,
    username: meta.username,
  });
  for (const client of room) {
    if (client !== ws && client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

async function handleRefreshToken(ws: WebSocket, meta: ConnectionMeta, token: string) {
  if (!token) return;
  try {
    const payload = await verifyToken(token);
    meta.userId = payload.userId;
    meta.username = payload.username;
    send(ws, { type: "tokenRefreshed" });
  } catch {
    send(ws, { type: "error", message: "Invalid token" });
  }
}

// ── Helpers ──

function handleDisconnect(ws: WebSocket, meta: ConnectionMeta) {
  const { projectId } = meta;
  leaveChat(ws, meta);
  leaveProject(ws, meta);
  unsubscribeBrowser(ws);
  connections.delete(ws);
  if (projectId) broadcastPresence(projectId);
  wsLog.debug("ws disconnected", { userId: meta.userId });
}

function leaveProject(ws: WebSocket, meta: ConnectionMeta) {
  if (!meta.projectId) return;
  const room = projectRooms.get(meta.projectId);
  room?.delete(ws);
  if (room && room.size === 0) projectRooms.delete(meta.projectId);
}

export function broadcastPresence(projectId: string) {
  broadcastToProject(projectId, {
    type: "presence",
    users: getPresence(projectId),
  });
}

function send(ws: WebSocket, message: WsBroadcastMessage) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}
