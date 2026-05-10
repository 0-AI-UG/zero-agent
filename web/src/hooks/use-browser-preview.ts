/**
 * Subscribes to `chat.browser-screenshot` WS frames for a project and
 * returns the most-recent frame (or null when the agent isn't currently
 * driving a page). The server emits a frame after every visible browser
 * action; idle browsers emit nothing, so this hook stays quiet too.
 */
import { useEffect, useState } from "react";
import { subscribe, subscribeBrowser, unsubscribeBrowser } from "@/lib/ws";

export interface BrowserPreviewFrame {
  hash: string;
  contentType: string;
  size: number;
  url: string;
  title: string;
  timestamp: number;
}

export function useBrowserPreview(projectId: string | undefined): BrowserPreviewFrame | null {
  const [frame, setFrame] = useState<BrowserPreviewFrame | null>(null);

  useEffect(() => {
    if (!projectId) return;
    setFrame(null);
    subscribeBrowser(projectId);
    const off = subscribe((msg) => {
      if (msg.type !== "browser.screenshot") return;
      if (msg.projectId !== projectId) return;
      const s = msg.screenshot as Partial<BrowserPreviewFrame> | undefined;
      if (!s?.hash) return;
      setFrame({
        hash: s.hash,
        contentType: s.contentType ?? "image/jpeg",
        size: s.size ?? 0,
        url: s.url ?? "",
        title: s.title ?? "",
        timestamp: s.timestamp ?? Date.now(),
      });
    });
    return () => {
      off();
      unsubscribeBrowser(projectId);
    };
  }, [projectId]);

  return frame;
}
