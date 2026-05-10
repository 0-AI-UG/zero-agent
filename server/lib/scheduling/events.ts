import { log } from "@/lib/utils/logger.ts";

const eventLog = log.child({ module: "events" });

// ── Event types ──

export type AgentEvents = {
  // Chat & messages
  "chat.created": { chatId: string; projectId: string; title: string };
  "chat.deleted": { chatId: string; projectId: string };
  "message.received": { chatId: string; projectId: string; content: string; userId: string };
  "message.sent": { chatId: string; projectId: string; content: string };

  // Files - full lifecycle
  "file.created": { projectId: string; path: string; filename: string; mimeType: string; sizeBytes: number };
  "file.updated": { projectId: string; path: string; filename: string; mimeType: string };
  "file.deleted": { projectId: string; path: string; filename: string };
  "file.moved": { projectId: string; fromPath: string; toPath: string; filename: string };
  "folder.created": { projectId: string; path: string };
  "folder.deleted": { projectId: string; path: string };

  // Scheduled tasks
  "task.started": { taskId: string; projectId: string; prompt: string };
  "task.completed": { taskId: string; projectId: string; summary: string };
  "task.failed": { taskId: string; projectId: string; error: string };

  // Skills
  "skill.loaded": { projectId: string; skillName: string; chatId: string };
  "skill.installed": { projectId: string; skillName: string; source: string };
  "skill.uninstalled": { projectId: string; skillName: string };
};

export type EventName = keyof AgentEvents;

// ── Internal event metadata ──

interface EventMeta {
  depth: number;
  timestamp: number;
}

type Handler<T> = (event: T & EventMeta) => void | Promise<void>;

// ── Event bus ──

const MAX_LISTENERS_PER_EVENT = 50;

class EventBus {
  private handlers = new Map<string, Set<Handler<any>>>();

  on<K extends EventName>(event: K, handler: Handler<AgentEvents[K]>): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    const set = this.handlers.get(event)!;
    if (set.size >= MAX_LISTENERS_PER_EVENT) {
      eventLog.warn("possible listener leak - too many handlers", { event, count: set.size });
    }
    set.add(handler);

    // Return unsubscribe function
    return () => {
      this.handlers.get(event)?.delete(handler);
    };
  }

  emit<K extends EventName>(event: K, data: AgentEvents[K], depth: number = 0): void {
    const handlers = this.handlers.get(event);
    if (!handlers || handlers.size === 0) return;

    const enriched = { ...data, depth, timestamp: Date.now() };

    eventLog.debug("event emitted", { event, depth });

    for (const handler of handlers) {
      try {
        const result = handler(enriched);
        // If handler returns a promise, catch errors
        if (result instanceof Promise) {
          result.catch((err) => {
            eventLog.error(`event handler error for ${event}`, err);
          });
        }
      } catch (err) {
        eventLog.error(`event handler error for ${event}`, err);
      }
    }
  }

  off<K extends EventName>(event: K, handler: Handler<AgentEvents[K]>): void {
    this.handlers.get(event)?.delete(handler);
  }

  removeAll(): void {
    this.handlers.clear();
  }
}

export const events = new EventBus();
