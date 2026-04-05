import { createResumableStreamContext } from "resumable-stream/generic";
import type { Publisher, Subscriber } from "resumable-stream/generic";

// In-memory Publisher implementation (no Redis needed)
class InMemoryPublisher implements Publisher {
  private store = new Map<string, string>();
  private channels = new Map<string, Set<(message: string) => void>>();

  async connect() {}

  async publish(channel: string, message: string) {
    const listeners = this.channels.get(channel);
    if (listeners) {
      listeners.forEach((cb) => cb(message));
    }
    return listeners?.size ?? 0;
  }

  async set(key: string, value: string, options?: { EX?: number }) {
    this.store.set(key, value);
    if (options?.EX) {
      setTimeout(() => this.store.delete(key), options.EX * 1000);
    }
    return "OK" as const;
  }

  async get(key: string) {
    return this.store.get(key) ?? null;
  }

  async incr(key: string) {
    const val = Number(this.store.get(key) ?? "0") + 1;
    this.store.set(key, String(val));
    return val;
  }

  // Internal: register a listener on a channel (used by subscriber)
  _subscribe(channel: string, cb: (message: string) => void) {
    let set = this.channels.get(channel);
    if (!set) {
      set = new Set();
      this.channels.set(channel, set);
    }
    set.add(cb);
  }

  _unsubscribe(channel: string, cb: (message: string) => void) {
    this.channels.get(channel)?.delete(cb);
  }
}

// In-memory Subscriber that delegates to the publisher's channel registry
class InMemorySubscriber implements Subscriber {
  private subscriptions = new Map<string, (message: string) => void>();

  constructor(private publisher: InMemoryPublisher) {}

  async connect() {}

  async subscribe(channel: string, callback: (message: string) => void) {
    this.subscriptions.set(channel, callback);
    this.publisher._subscribe(channel, callback);
  }

  async unsubscribe(channel: string) {
    const cb = this.subscriptions.get(channel);
    if (cb) {
      this.publisher._unsubscribe(channel, cb);
      this.subscriptions.delete(channel);
    }
  }
}

const publisher = new InMemoryPublisher();
const subscriber = new InMemorySubscriber(publisher);

export const streamContext = createResumableStreamContext({
  waitUntil: null,
  publisher,
  subscriber,
});

// Track active stream IDs per chat
const activeStreams = new Map<string, string>();

export function setActiveStreamId(chatId: string, streamId: string) {
  activeStreams.set(chatId, streamId);
}

export function getActiveStreamId(chatId: string): string | undefined {
  return activeStreams.get(chatId);
}

export function clearActiveStreamId(chatId: string) {
  activeStreams.delete(chatId);
}

// Track abort flags per chat so streams can be cancelled at step boundaries.
const abortedChats = new Set<string>();

export function requestAbort(chatId: string): boolean {
  if (activeStreams.has(chatId)) {
    abortedChats.add(chatId);
    return true;
  }
  return false;
}

export function isAbortRequested(chatId: string): boolean {
  return abortedChats.has(chatId);
}

export function clearAbortFlag(chatId: string) {
  abortedChats.delete(chatId);
}
