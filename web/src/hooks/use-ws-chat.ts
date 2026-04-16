/**
 * `useWsChat(chatId)` — realtime chat hook.
 *
 * The server pushes a single `chat.snapshot` on subscribe, then per-message
 * `chat.message` deltas and `chat.streamBegin` / `chat.streamEnd` status
 * frames. We keep a module-scoped Map of scenes and write deltas into it;
 * components read via `useSyncExternalStore`. TCP ordering means deltas
 * are idempotent against the most recent snapshot.
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

function notify(chatId: string) {
  const subs = listeners.get(chatId);
  if (subs) for (const cb of subs) cb();
}

function upsertMessage(scene: Scene, message: Message): Scene {
  const messages = scene.messages.slice();
  const idx = messages.findIndex((m) => m.id === message.id);
  if (idx >= 0) messages[idx] = message;
  else messages.push(message);
  return { ...scene, messages };
}

function ensureWired() {
  if (wired) return;
  wired = true;
  subscribe((msg) => {
    if (!msg || typeof msg !== "object") return;
    const chatId = typeof msg.chatId === "string" ? msg.chatId : null;
    if (!chatId) return;
    const current = scenes.get(chatId) ?? EMPTY_SCENE;
    switch (msg.type) {
      case "chat.snapshot": {
        scenes.set(chatId, {
          messages: Array.isArray(msg.messages) ? (msg.messages as Message[]) : [],
          isStreaming: !!msg.isStreaming,
          streamId: typeof msg.streamId === "string" ? msg.streamId : undefined,
          error: typeof msg.error === "string" ? msg.error : undefined,
        });
        notify(chatId);
        return;
      }
      case "chat.message": {
        if (!msg.message?.id) return;
        scenes.set(chatId, upsertMessage(current, msg.message as Message));
        notify(chatId);
        return;
      }
      case "chat.delta": {
        if (!msg.messageId || msg.partIndex == null || typeof msg.text !== "string") return;
        const msgIdx = current.messages.findIndex((m) => m.id === msg.messageId);
        if (msgIdx < 0) return;
        const oldMsg = current.messages[msgIdx]!;
        const part = oldMsg.parts[msg.partIndex as number];
        if (part && (part.type === "text" || part.type === "reasoning")) {
          const updatedPart = { ...part, text: part.text + msg.text };
          const updatedParts = oldMsg.parts.slice();
          updatedParts[msg.partIndex as number] = updatedPart;
          const updatedMsg = { ...oldMsg, parts: updatedParts };
          const updatedMessages = current.messages.slice();
          updatedMessages[msgIdx] = updatedMsg;
          scenes.set(chatId, { ...current, messages: updatedMessages });
          notify(chatId);
        }
        return;
      }
      case "chat.streamBegin": {
        scenes.set(chatId, {
          ...current,
          isStreaming: true,
          streamId: typeof msg.streamId === "string" ? msg.streamId : undefined,
          error: undefined,
        });
        notify(chatId);
        return;
      }
      case "chat.streamEnd": {
        scenes.set(chatId, {
          ...current,
          isStreaming: false,
          error: typeof msg.error === "string" ? msg.error : undefined,
        });
        notify(chatId);
        return;
      }
    }
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
