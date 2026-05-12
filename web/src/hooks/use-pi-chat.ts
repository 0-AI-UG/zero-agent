/**
 * `usePiChat(chatId)` — realtime chat hook over the immediate-mode
 * `chat.state` protocol.
 *
 * The server holds the canonical chat state and broadcasts the full
 * state whenever a message finalizes. This hook just stores the latest
 * snapshot — no per-event reduction, no token streaming.
 */
import { useCallback, useSyncExternalStore } from "react";
import { send, subscribe } from "@/lib/ws";
import type { AgentMessage, PendingTool } from "@/lib/pi-events";
import { useModelStore } from "@/stores/model";

export type ChatStatus = "ready" | "streaming" | "error";

export interface SendMessageImage {
  /** Base64 image bytes (no data: prefix). */
  data: string;
  mimeType: string;
}

export interface SendMessageOptions {
  text?: string;
  images?: SendMessageImage[];
}

export interface UsePiChatResult {
  messages: AgentMessage[];
  pendingTools: PendingTool[];
  status: ChatStatus;
  error?: string;
  isStreaming: boolean;
  runId?: string;
  sendMessage: (opts: SendMessageOptions) => void;
  stop: () => void;
}

interface Scene {
  messages: AgentMessage[];
  pendingTools: PendingTool[];
  isStreaming: boolean;
  runId?: string;
  error?: string;
}

const EMPTY_SCENE: Scene = {
  messages: [],
  pendingTools: [],
  isStreaming: false,
};

const scenes = new Map<string, Scene>();
const listeners = new Map<string, Set<() => void>>();
let wired = false;

function getScene(chatId: string): Scene {
  return scenes.get(chatId) ?? EMPTY_SCENE;
}

function notify(chatId: string) {
  const subs = listeners.get(chatId);
  if (subs) for (const cb of subs) cb();
}

function ensureWired() {
  if (wired) return;
  wired = true;
  subscribe((msg) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.type !== "chat.state") return;
    const chatId = typeof msg.chatId === "string" ? msg.chatId : null;
    if (!chatId) return;

    scenes.set(chatId, {
      messages: Array.isArray(msg.messages) ? (msg.messages as AgentMessage[]) : [],
      pendingTools: Array.isArray(msg.pendingTools) ? (msg.pendingTools as PendingTool[]) : [],
      isStreaming: !!msg.isStreaming,
      runId: typeof msg.runId === "string" ? msg.runId : undefined,
      error: typeof msg.error === "string" ? msg.error : undefined,
    });
    notify(chatId);
  });
}

function subscribeScene(chatId: string, cb: () => void): () => void {
  ensureWired();
  let set = listeners.get(chatId);
  if (!set) {
    set = new Set();
    listeners.set(chatId, set);
  }
  set.add(cb);
  return () => {
    const s = listeners.get(chatId);
    if (!s) return;
    s.delete(cb);
    if (s.size === 0) listeners.delete(chatId);
  };
}

export function usePiChat(chatId: string): UsePiChatResult {
  const scene = useSyncExternalStore(
    (cb) => subscribeScene(chatId, cb),
    () => getScene(chatId),
  );

  const sendMessage = useCallback(
    (opts: SendMessageOptions) => {
      const text = (opts.text ?? "").trim();
      const images = opts.images ?? [];
      if (!text && images.length === 0) return;
      send({
        type: "chat.send",
        chatId,
        text,
        ...(images.length > 0 ? { images } : {}),
        model: useModelStore.getState().selectedModelId,
      });
    },
    [chatId],
  );

  const stop = useCallback(() => {
    send({ type: "chat.stop", chatId });
  }, [chatId]);

  const status: ChatStatus = scene.error
    ? "error"
    : scene.isStreaming
      ? "streaming"
      : "ready";

  return {
    messages: scene.messages,
    pendingTools: scene.pendingTools,
    status,
    error: scene.error,
    isStreaming: scene.isStreaming,
    runId: scene.runId,
    sendMessage,
    stop,
  };
}
