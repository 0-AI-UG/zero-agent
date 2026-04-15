/**
 * Browser-preview subscriptions over WS.
 *
 * Replaces the 5s `/api/projects/:id/chats/:cid/browser-screenshot` client
 * poll. A viewer that opens the preview sends `subscribeBrowser {projectId}`.
 * Server fetches frames from the runner on a bounded interval, hashes them
 * through the blob store, and broadcasts `browser.screenshot` only on
 * change — so an idle browser emits zero WS traffic after the first frame.
 *
 * Per-project so multiple chats in the same project share one tick loop;
 * `chat.browser-screenshot` has always been project-scoped in practice.
 */
import { WebSocket } from "ws";
import { log } from "@/lib/utils/logger.ts";
import { getLocalBackend } from "@/lib/execution/lifecycle.ts";
import { putBlob } from "@/lib/media/blob-store.ts";

const wsbLog = log.child({ module: "ws-browser" });

interface Subscription {
  subscribers: Set<WebSocket>;
  interval: ReturnType<typeof setInterval> | null;
  lastHash: string | null;
  inFlight: boolean;
}

const subs = new Map<string, Subscription>();

const TICK_MS = 3_000;

async function tick(projectId: string): Promise<void> {
  const s = subs.get(projectId);
  if (!s || s.subscribers.size === 0) return;
  if (s.inFlight) return;
  s.inFlight = true;
  try {
    const backend = getLocalBackend();
    const shot = (await backend?.getLatestScreenshot(projectId)) ?? null;
    if (!shot?.base64) return;
    const bytes = Buffer.from(shot.base64, "base64");
    const { hash, size, contentType } = await putBlob(bytes, "image/jpeg", projectId);
    if (hash === s.lastHash) return;
    s.lastHash = hash;
    const frame = {
      type: "browser.screenshot",
      projectId,
      screenshot: {
        hash,
        contentType,
        size,
        title: shot.title,
        url: shot.url,
        timestamp: shot.timestamp,
      },
    };
    const data = JSON.stringify(frame);
    for (const ws of s.subscribers) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    }
  } catch (err) {
    wsbLog.debug("browser tick failed", { projectId, err: String(err) });
  } finally {
    s.inFlight = false;
  }
}

export function subscribeBrowser(ws: WebSocket, projectId: string): void {
  if (!projectId) return;
  let s = subs.get(projectId);
  if (!s) {
    s = { subscribers: new Set(), interval: null, lastHash: null, inFlight: false };
    subs.set(projectId, s);
  }
  s.subscribers.add(ws);
  if (!s.interval) {
    s.interval = setInterval(() => { void tick(projectId); }, TICK_MS);
    void tick(projectId); // emit first frame immediately
  } else if (s.lastHash) {
    // Re-seed a late joiner with the most recent frame we already have.
    // Causes one extra runner fetch so we also get the fresh title/url.
    void tick(projectId);
  }
}

export function unsubscribeBrowser(ws: WebSocket, projectId?: string): void {
  const targets = projectId ? [projectId] : [...subs.keys()];
  for (const pid of targets) {
    const s = subs.get(pid);
    if (!s) continue;
    s.subscribers.delete(ws);
    if (s.subscribers.size === 0) {
      if (s.interval) clearInterval(s.interval);
      subs.delete(pid);
    }
  }
}

export function browserSubStats() {
  return { projects: subs.size, totalSubscribers: [...subs.values()].reduce((n, s) => n + s.subscribers.size, 0) };
}
