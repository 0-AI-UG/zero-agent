/**
 * Browser-preview subscriptions over WS.
 *
 * Event-driven (vs. the old 3s poll loop): the host browser pool emits a
 * `frame` event after every successful action that visibly changes the
 * page. We dedupe via the blob store hash and forward `browser.screenshot`
 * to project subscribers. Idle browsers emit zero WS traffic.
 */
import { WebSocket } from "ws";
import { log } from "@/lib/utils/logger.ts";
import { getBrowserPool, type ScreenshotFrame } from "@/lib/browser/host-pool.ts";
import { putBlob } from "@/lib/media/blob-store.ts";

const wsbLog = log.child({ module: "ws-browser" });

interface ProjectSub {
  subscribers: Set<WebSocket>;
  lastHash: string | null;
}

const subs = new Map<string, ProjectSub>();
let frameListener: ((f: ScreenshotFrame) => void) | null = null;

function ensureListener() {
  if (frameListener) return;
  const handler = (frame: ScreenshotFrame) => {
    void publish(frame).catch((err) =>
      wsbLog.debug("publish failed", { projectId: frame.projectId, err: String(err) }),
    );
  };
  frameListener = handler;
  getBrowserPool().on("frame", handler);
}

async function publish(frame: ScreenshotFrame): Promise<void> {
  const sub = subs.get(frame.projectId);
  if (!sub || sub.subscribers.size === 0) return;
  const bytes = Buffer.from(frame.base64, "base64");
  const { hash, size, contentType } = await putBlob(bytes, "image/jpeg", frame.projectId);
  if (hash === sub.lastHash) return;
  sub.lastHash = hash;
  const data = JSON.stringify({
    type: "browser.screenshot",
    projectId: frame.projectId,
    screenshot: {
      hash, contentType, size,
      title: frame.title,
      url: frame.url,
      timestamp: frame.timestamp,
    },
  });
  for (const ws of sub.subscribers) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

export function subscribeBrowser(ws: WebSocket, projectId: string): void {
  if (!projectId) return;
  ensureListener();
  let s = subs.get(projectId);
  if (!s) {
    s = { subscribers: new Set(), lastHash: null };
    subs.set(projectId, s);
  }
  s.subscribers.add(ws);
  // Re-seed late joiners with the most recent frame.
  const last = getBrowserPool().lastFrameFor(projectId);
  if (last) void publish(last).catch(() => {});
}

export function unsubscribeBrowser(ws: WebSocket, projectId?: string): void {
  const targets = projectId ? [projectId] : [...subs.keys()];
  for (const pid of targets) {
    const s = subs.get(pid);
    if (!s) continue;
    s.subscribers.delete(ws);
    if (s.subscribers.size === 0) subs.delete(pid);
  }
}

export function browserSubStats() {
  return {
    projects: subs.size,
    totalSubscribers: [...subs.values()].reduce((n, s) => n + s.subscribers.size, 0),
  };
}
