/**
 * `useWsChat(chatId)` — realtime chat hook.
 *
 * The server owns chat state and pushes a full `chat.scene` frame on every
 * change. A single WS subscriber writes each frame into a module-scoped Map;
 * components read via `useSyncExternalStore`. No reducer, no local state,
 * no seq, no replay — TCP ordering + complete snapshots make frames
 * idempotent.
 */
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { send, subscribe } from "@/lib/ws";
import type { FilePart, Message, Part } from "@/lib/messages";
import { useModelStore } from "@/stores/model";
import { useToolsStore } from "@/stores/tools";
import { usePlanModeStore } from "@/stores/plan-mode";

export type ChatStatus = "ready" | "streaming" | "error";

export interface SendMessageOptions {
  text?: string;
  files?: FilePart[];
}

export interface UseWsChatResult {
  messages: Message[];
  status: ChatStatus;
  error?: string;
  isStreaming: boolean;
  sendMessage: (opts: SendMessageOptions) => void;
  stop: () => void;
  regenerate: (messageId?: string) => void;
}

// ── Scene store ──────────────────────────────────────────────────────────

interface Scene {
  messages: Message[];
  isStreaming: boolean;
  streamId?: string;
  error?: string;
}

const EMPTY_SCENE: Scene = { messages: [], isStreaming: false };

const scenes = new Map<string, Scene>();
const listeners = new Map<string, Set<() => void>>();
let wired = false;

function ensureWired() {
  if (wired) return;
  wired = true;
  subscribe((msg) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.type !== "chat.scene") return;
    if (typeof msg.chatId !== "string") return;
    scenes.set(msg.chatId, {
      messages: Array.isArray(msg.messages) ? (msg.messages as Message[]) : [],
      isStreaming: !!msg.isStreaming,
      streamId: typeof msg.streamId === "string" ? msg.streamId : undefined,
      error: typeof msg.error === "string" ? msg.error : undefined,
    });
    const subs = listeners.get(msg.chatId);
    if (subs) for (const cb of subs) cb();
  });
}

function getScene(chatId: string): Scene {
  return scenes.get(chatId) ?? EMPTY_SCENE;
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

// ── Hook ─────────────────────────────────────────────────────────────────

export function useWsChat(chatId: string): UseWsChatResult {
  const scene = useSyncExternalStore(
    (cb) => subscribeScene(chatId, cb),
    () => getScene(chatId),
  );

  const sendMessage = useCallback(
    (opts: SendMessageOptions) => {
      const text = opts.text ?? "";
      const attachments: Part[] = opts.files ? [...opts.files] : [];
      if (!text && attachments.length === 0) return;
      const planMode =
        usePlanModeStore.getState().enabledChats[chatId] || undefined;
      send({
        type: "chat.send",
        chatId,
        text,
        attachments,
        model: useModelStore.getState().selectedModelId,
        language: useModelStore.getState().language,
        disabledTools: useToolsStore.getState().getDisabledToolsList(),
        planMode,
      });
    },
    [chatId],
  );

  const stop = useCallback(() => {
    send({ type: "chat.stop", chatId });
  }, [chatId]);

  const regenerate = useCallback(
    (messageId?: string) => {
      let targetId = messageId;
      if (!targetId) {
        for (let i = scene.messages.length - 1; i >= 0; i--) {
          if (scene.messages[i]!.role === "assistant") {
            targetId = scene.messages[i]!.id;
            break;
          }
        }
      }
      if (!targetId) return;
      const planMode =
        usePlanModeStore.getState().enabledChats[chatId] || undefined;
      send({
        type: "chat.regenerate",
        chatId,
        messageId: targetId,
        model: useModelStore.getState().selectedModelId,
        language: useModelStore.getState().language,
        disabledTools: useToolsStore.getState().getDisabledToolsList(),
        planMode,
      });
    },
    [chatId, scene.messages],
  );

  // Pending auto-send text queued by the server (e.g. plan implement).
  // Held until the current stream finishes, then flushed.
  const autoSendRef = useRef<string | null>(null);
  const wasStreamingRef = useRef(scene.isStreaming);

  useEffect(() => {
    return subscribe((msg) => {
      if (msg?.type !== "chat.autoSend") return;
      if (msg.chatId && msg.chatId !== chatId) return;
      const text = typeof msg.message === "string" ? msg.message : "";
      if (!text) return;
      if (getScene(chatId).isStreaming) autoSendRef.current = text;
      else sendMessage({ text });
    });
  }, [chatId, sendMessage]);

  useEffect(() => {
    if (wasStreamingRef.current && !scene.isStreaming && autoSendRef.current) {
      const text = autoSendRef.current;
      autoSendRef.current = null;
      sendMessage({ text });
    }
    wasStreamingRef.current = scene.isStreaming;
  }, [scene.isStreaming, sendMessage]);

  const status: ChatStatus = scene.error
    ? "error"
    : scene.isStreaming
      ? "streaming"
      : "ready";

  return {
    messages: scene.messages,
    status,
    error: scene.error,
    isStreaming: scene.isStreaming,
    sendMessage,
    stop,
    regenerate,
  };
}
