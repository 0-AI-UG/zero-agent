import { WebSocketServer, WebSocket } from "ws";
import type { Server as HttpServer, IncomingMessage } from "node:http";
import { verifyToken, type TokenPayload } from "@/lib/auth/auth.ts";
import { isProjectMember } from "@/db/queries/members.ts";
import { getUserById } from "@/db/queries/users.ts";
import { getProjectById } from "@/db/queries/projects.ts";
import { getMessagesByChatTail } from "@/db/queries/messages.ts";
import { log } from "@/lib/utils/logger.ts";
import { isChatWsMessage, handleChatMessage } from "@/lib/http/ws-chat.ts";
import { subscribeBrowser, unsubscribeBrowser } from "@/lib/http/ws-browser.ts";
import type { Message, Part } from "@/lib/messages/types.ts";

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

// ── Chat scenes ──
//
// Per-chat streaming state. Scenes hold metadata and a small in-flight
// working set of messages that belong to the current turn (and thus
// aren't in the DB yet). On a viewer joining, we send one snapshot
// (tail of DB + in-flight overlay); every subsequent message is a
// `chat.message` delta. That keeps serialization cost O(delta) rather
// than O(history) per viewer per tick.

interface ChatScene {
  chatId: string;
  isStreaming: boolean;
  streamId?: string;
  /** In-flight messages for the current turn, keyed by id. Cleared on stream end. */
  working: Map<string, Message>;
  error?: string;
  lastAccessAt: number;
  /**
   * Per-message-id structural signature of the last broadcast. Content-only
   * deltas (text, reasoning) skip publishMessage and go out via publishChatDelta
   * as lightweight frames, so structural changes are the only thing that needs
   * dedup here.
   */
  lastSignatures: Map<string, string>;
}

const WS_BUFFER_HIGH_WATER = 1 * 1024 * 1024; // 1 MB — skip sends when the kernel can't drain fast enough
const WS_FRAME_SIZE_CAP = 4 * 1024 * 1024; // 4 MB — hard cap; drop pathologically large frames
const TOOL_PART_TRUNCATE_BYTES = 20 * 1024; // 20 KB — truncate large tool inputs/outputs before broadcasting

const chatScenes = new Map<string, ChatScene>();

const CHAT_SCENE_MAX = 50;
const CHAT_SCENE_IDLE_MS = 60 * 60 * 1000; // 1h
const SNAPSHOT_TAIL_LIMIT = 200;

function touchScene(s: ChatScene) {
  s.lastAccessAt = Date.now();
}

function getOrCreateScene(chatId: string): ChatScene {
  let s = chatScenes.get(chatId);
  if (s) {
    touchScene(s);
    return s;
  }
  s = {
    chatId,
    isStreaming: false,
    working: new Map(),
    lastAccessAt: Date.now(),
    lastSignatures: new Map(),
  };
  chatScenes.set(chatId, s);
  if (chatScenes.size > CHAT_SCENE_MAX) evictChatScenes();
  return s;
}

function evictChatScenes() {
  const now = Date.now();
  const candidates: ChatScene[] = [];
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

/**
 * Build a fresh snapshot for a joining viewer: tail of persisted messages
 * from the DB, then any in-flight working messages overlaid on top (by id).
 */
function buildSnapshot(chatId: string): WsBroadcastMessage {
  const s = getOrCreateScene(chatId);
  const tail: Message[] = [];
  const byId = new Map<string, Message>();
  for (const row of getMessagesByChatTail(chatId, SNAPSHOT_TAIL_LIMIT)) {
    let m: Message | null;
    try { m = JSON.parse(row.content) as Message; } catch { continue; }
    if (!m?.id || (m.parts?.length ?? 0) === 0) continue;
    tail.push(m);
    byId.set(m.id, m);
  }
  for (const [id, m] of s.working) {
    const prepared = prepareForBroadcast(m);
    if (byId.has(id)) {
      const idx = tail.findIndex((x) => x.id === id);
      if (idx >= 0) tail[idx] = prepared;
    } else {
      tail.push(prepared);
    }
  }
  return {
    type: "chat.snapshot",
    chatId,
    messages: tail,
    isStreaming: s.isStreaming,
    streamId: s.streamId,
    error: s.error,
  };
}

export function beginChatStream(
  chatId: string,
  initialMessages: Message[] = [],
  streamId?: string,
): void {
  const s = getOrCreateScene(chatId);
  s.streamId = streamId;
  s.isStreaming = true;
  s.error = undefined;
  s.lastSignatures.clear();
  s.working.clear();
  // Only the newest message is truly in-flight (typically the user turn that
  // hasn't been committed yet). Earlier messages in `initialMessages` are
  // already persisted and will be served from the DB tail in `buildSnapshot`;
  // mirroring them in `working` would reintroduce the history-shaped memory
  // footprint this whole scene rewrite was meant to eliminate.
  const last = initialMessages[initialMessages.length - 1];
  if (last?.id) s.working.set(last.id, last);
  broadcastToChat(chatId, {
    type: "chat.streamBegin",
    chatId,
    streamId,
  });
  // Emit a delta for the newest seed message so already-subscribed viewers
  // see it right away without a full snapshot replay.
  if (last?.id) {
    broadcastToChat(chatId, { type: "chat.message", chatId, message: last });
  }
}

/**
 * Cheap structural fingerprint of a message. Changes only when a renderer
 * would need to update layout (new part, tool-call state transition, metadata
 * attached). Content-only growth within a part does not change the signature,
 * so intra-token deltas get coalesced.
 */
function messageSignature(m: Message): string {
  const parts: string[] = [];
  for (const p of m.parts as Part[]) {
    // A part's identity for signature purposes is its type plus any discrete
    // lifecycle field it carries. This covers today's parts (tool-call has
    // `state`; search/generation parts have `status`) without enumerating
    // them. Content fields like `text` or `arguments` are deliberately
    // ignored — that's what we want to coalesce.
    const lifecycle =
      (p as { state?: string }).state ?? (p as { status?: string }).status ?? "";
    parts.push(lifecycle ? `${p.type}:${lifecycle}` : p.type);
  }
  return `${parts.length}|${parts.join(",")}|${m.metadata ? "m" : ""}`;
}

function truncateField(value: unknown): unknown {
  if (value == null) return value;
  const json = typeof value === "string" ? value : JSON.stringify(value);
  if (json.length <= TOOL_PART_TRUNCATE_BYTES) return value;
  return { _truncated: true, preview: json.slice(0, 500), byteLength: json.length };
}

function prepareForBroadcast(message: Message): Message {
  const parts = message.parts.map((p) => {
    if (p.type !== "dynamic-tool") return p;
    const dt = p as { type: string; input?: unknown; output?: unknown; [k: string]: unknown };
    const newInput = truncateField(dt.input);
    const newOutput = truncateField(dt.output);
    if (newInput === dt.input && newOutput === dt.output) return p;
    return { ...dt, input: newInput, output: newOutput } as Part;
  });
  if (parts === message.parts) return message;
  return { ...message, parts };
}

function emitChatMessage(chatId: string, message: Message): void {
  broadcastToChat(chatId, { type: "chat.message", chatId, message: prepareForBroadcast(message) });
}

export function publishChatMessage(chatId: string, message: Message): void {
  const s = getOrCreateScene(chatId);
  if (!message?.id) return;
  s.working.set(message.id, message);

  const sig = messageSignature(message);
  if (s.lastSignatures.get(message.id) === sig) {
    // Content-only delta — caller sends it via publishChatDelta.
    return;
  }
  s.lastSignatures.set(message.id, sig);
  emitChatMessage(chatId, message);
}

/**
 * Broadcast a lightweight text/reasoning delta to chat viewers.
 * Sends a tiny `chat.delta` envelope instead of the full ~40KB message,
 * eliminating the repeated JSON.stringify OOM that content-only streaming caused.
 */
export function publishChatDelta(
  chatId: string,
  messageId: string,
  partIndex: number,
  deltaText: string,
): void {
  const s = getOrCreateScene(chatId);
  touchScene(s);
  broadcastToChat(chatId, { type: "chat.delta", chatId, messageId, partIndex, text: deltaText });
}

export function endChatStream(
  chatId: string,
  reason: "completed" | "aborted" | "error",
  error?: string,
): void {
  const s = getOrCreateScene(chatId);
  s.isStreaming = false;
  s.error = reason === "error" ? error ?? "Stream ended with an error" : undefined;
  // Emit the final full state for each in-flight working message so clients
  // have the complete content after any content-only deltas.
  for (const message of s.working.values()) {
    emitChatMessage(chatId, message);
  }
  s.lastSignatures.clear();
  // Release the in-flight working set. DB is authoritative from here on; a
  // late viewer's snapshot will rebuild from the tail.
  s.working.clear();
  broadcastToChat(chatId, {
    type: "chat.streamEnd",
    chatId,
    reason,
    error: s.error,
  });
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

    // wss may have been nulled out during the await above (shutdown race)
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

  // Ping interval to detect dead connections
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

/** Heap-pressure hook: drop idle scenes aggressively. */
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
  // Dedupe by userId (a user may have multiple tabs); prefer the one with a chatId.
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
        // Only allow subscribing to the project the socket has already joined
        // (which went through handleJoin's membership check). This prevents
        // authenticated users from reading screenshots of projects they're
        // not a member of by providing an arbitrary projectId.
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

  // Verify membership (admins bypass, matching verifyProjectAccess logic)
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

  // Leave old room (chat subscription too)
  leaveChat(ws, meta);
  leaveProject(ws, meta);

  // Join new room
  meta.projectId = projectId;
  if (!projectRooms.has(projectId)) {
    projectRooms.set(projectId, new Set());
  }
  projectRooms.get(projectId)!.add(ws);

  wsLog.debug("user joined project", { userId: meta.userId, projectId });

  // Send current presence to the joining user
  send(ws, { type: "presence", users: getPresence(projectId) });

  // Broadcast updated presence to all members
  broadcastPresence(projectId);
}

function handleViewChat(ws: WebSocket, meta: ConnectionMeta, chatId: string) {
  if (!chatId || !meta.projectId) return;

  leaveChat(ws, meta);

  // Join new chat
  meta.chatId = chatId;
  if (!chatViewers.has(chatId)) {
    chatViewers.set(chatId, new Set());
  }
  chatViewers.get(chatId)!.add(ws);

  // Send a snapshot (DB tail + in-flight overlay). After this, the viewer
  // only receives `chat.message` / `chat.streamBegin` / `chat.streamEnd`
  // deltas — full scene frames are no longer broadcast per tick.
  send(ws, buildSnapshot(chatId));

  // Broadcast updated presence to the project
  broadcastPresence(meta.projectId);
}

function handleLeaveChat(ws: WebSocket, meta: ConnectionMeta) {
  if (!meta.chatId) return;
  leaveChat(ws, meta);
  if (meta.projectId) broadcastPresence(meta.projectId);
}

/** Detach ws from its current chat's viewer set. */
function leaveChat(ws: WebSocket, meta: ConnectionMeta) {
  if (!meta.chatId) return;
  const viewers = chatViewers.get(meta.chatId);
  viewers?.delete(ws);
  if (viewers && viewers.size === 0) chatViewers.delete(meta.chatId);
  meta.chatId = null;
}

function handleTyping(ws: WebSocket, meta: ConnectionMeta, chatId: string) {
  if (!meta.projectId || !chatId) return;
  // Broadcast to all project members except the sender
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

/** Detach ws from its current project room. */
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
