import { apiFetch } from "@/api/client";
import { useAuthStore } from "@/stores/auth";
import { useState, useCallback, useRef, useEffect } from "react";

export interface FileSearchResult {
  fileId: string;
  filename: string;
  snippet: string;
}

export async function searchFiles(
  projectId: string,
  query: string,
): Promise<{ results: FileSearchResult[] }> {
  return apiFetch(`/projects/${projectId}/files/search?q=${encodeURIComponent(query)}`);
}

export interface ReindexProgress {
  phase: "files" | "done" | "error" | "queued";
  current: number;
  total: number;
  detail?: string;
}

function readSSEStream(
  body: ReadableStream<Uint8Array>,
  onProgress: (data: ReindexProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise(async (resolve) => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() ?? "";

        for (const chunk of lines) {
          const dataLine = chunk.trim();
          if (!dataLine.startsWith("data: ")) continue;
          try {
            const data = JSON.parse(dataLine.slice(6)) as ReindexProgress;
            onProgress(data);
          } catch {
            // skip unparseable
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        onProgress({ phase: "error", current: 0, total: 0, detail: (err as Error).message });
      }
    } finally {
      resolve();
    }
  });
}

export function useReindexProject(projectId: string) {
  const [progress, setProgress] = useState<ReindexProgress | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // On mount: check if a reindex is already running and reconnect
  useEffect(() => {
    let cancelled = false;

    async function checkStatus() {
      try {
        const token = useAuthStore.getState().token;
        const res = await fetch(`/api/projects/${projectId}/reindex/status`, {
          credentials: "include",
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        });
        if (!res.ok || cancelled) return;

        const status = await res.json() as { running: boolean; progress?: ReindexProgress };
        if (!status.running || cancelled) return;

        // Reindex is running - show last known progress and reconnect to stream
        setIsRunning(true);
        if (status.progress) setProgress(status.progress);

        const controller = new AbortController();
        abortRef.current = controller;

        const streamRes = await fetch(`/api/projects/${projectId}/reindex/stream`, {
          credentials: "include",
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
          signal: controller.signal,
        });

        if (!streamRes.ok || !streamRes.body || cancelled) {
          setIsRunning(false);
          return;
        }

        // Check if the response is JSON (idle) rather than SSE
        const contentType = streamRes.headers.get("content-type") ?? "";
        if (contentType.includes("application/json")) {
          setIsRunning(false);
          return;
        }

        await readSSEStream(streamRes.body, (data) => {
          if (!cancelled) setProgress(data);
        }, controller.signal);

        if (!cancelled) setIsRunning(false);
      } catch {
        // Ignore - page may have unmounted
      }
    }

    checkStatus();
    return () => {
      cancelled = true;
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [projectId]);

  const start = useCallback(async () => {
    if (isRunning) return;
    setIsRunning(true);
    setProgress({ phase: "files", current: 0, total: 0 });

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const token = useAuthStore.getState().token;
      const { readCsrfCookie } = await import("@/stores/auth");
      const csrf = readCsrfCookie();
      const headers: Record<string, string> = {};
      if (token) headers["Authorization"] = `Bearer ${token}`;
      if (csrf) headers["X-CSRF-Token"] = csrf;

      // Kick off the reindex
      const res = await fetch(`/api/projects/${projectId}/reindex`, {
        method: "POST",
        credentials: "include",
        headers,
        signal: controller.signal,
      });

      if (!res.ok) {
        setProgress({ phase: "error", current: 0, total: 0, detail: "Request failed" });
        setIsRunning(false);
        return;
      }

      // Small delay to let the server initialize state before connecting to stream
      await new Promise(r => setTimeout(r, 50));

      // Connect to the SSE stream for progress
      const streamRes = await fetch(`/api/projects/${projectId}/reindex/stream`, {
        credentials: "include",
        headers,
        signal: controller.signal,
      });

      const contentType = streamRes.headers.get("content-type") ?? "";
      if (!streamRes.ok || !streamRes.body || contentType.includes("application/json")) {
        // Reindex may have finished instantly
        setIsRunning(false);
        return;
      }

      await readSSEStream(streamRes.body, setProgress, controller.signal);
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setProgress({ phase: "error", current: 0, total: 0, detail: (err as Error).message });
      }
    } finally {
      setIsRunning(false);
      abortRef.current = null;
    }
  }, [projectId, isRunning]);

  const reset = useCallback(() => {
    if (!isRunning) setProgress(null);
  }, [isRunning]);

  return { progress, isRunning, start, reset };
}
