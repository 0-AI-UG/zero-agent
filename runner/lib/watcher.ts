/**
 * Filesystem watcher for container /workspace.
 * Prefers inotifywait (inotify-tools) inside the container via `docker exec`.
 * Falls back to Node fs.watch recursive if inotifywait is unavailable.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { log } from "./logger.ts";
import { WATCHER_CONFIG } from "./watcher-config.ts";

const watcherLog = log.child({ module: "watcher" });

export type WatcherEvent =
  | { kind: "upsert"; path: string; size: number; mtime: number }
  | { kind: "delete"; path: string };

export interface WatcherHandle {
  /** Add a subscriber. Returns an unsubscribe fn. */
  subscribe(fn: (event: WatcherEvent) => void): () => void;
  /** Fire all pending debounce timers immediately and wait for delivery. */
  flush(): Promise<void>;
  /** Stop watching and release resources. */
  stop(): void;
}

interface PendingEntry {
  timer: ReturnType<typeof setTimeout>;
  pending: WatcherEvent;
}

/** Build the inotifywait --exclude regex from the config excludes list. */
function buildExcludeRegex(): string {
  const parts = WATCHER_CONFIG.excludes.map((e) => `/${e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`);
  return `(${parts.join("|")})`;
}

/**
 * Stat a file inside the container using `docker exec`.
 * Returns { size, mtime } or null if the file doesn't exist or is a directory.
 */
async function statInContainer(containerName: string, absPath: string): Promise<{ size: number; mtime: number } | null> {
  return new Promise((resolve) => {
    const proc = spawn("docker", [
      "exec", containerName,
      "stat", "-c", "%s %Y %F", absPath,
    ]);
    let out = "";
    proc.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    proc.on("close", () => {
      const parts = out.trim().split(" ");
      // parts: [size, mtime_epoch_secs, file_type...]
      if (parts.length < 3) { resolve(null); return; }
      const type = parts.slice(2).join(" "); // e.g. "regular file" or "directory"
      if (type.includes("directory")) { resolve(null); return; }
      const size = Number(parts[0]);
      const mtime = Number(parts[1]) * 1000; // convert to ms
      if (isNaN(size) || isNaN(mtime)) { resolve(null); return; }
      resolve({ size, mtime });
    });
    proc.on("error", () => resolve(null));
  });
}

function startInotifyWatcher(
  containerName: string,
  root: string,
  onEvent: (event: WatcherEvent) => void,
  onExit: (code: number | null) => void,
): ReturnType<typeof spawn> {
  const excludeRegex = buildExcludeRegex();
  const proc = spawn("docker", [
    "exec", "-i", containerName,
    "inotifywait",
    "-mr",
    "--format", "%e|%w%f",
    "--event", "create,modify,delete,moved_to,moved_from",
    "--exclude", excludeRegex,
    root,
  ]);

  let buffer = "";

  proc.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? ""; // keep incomplete last line
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const pipeIdx = trimmed.indexOf("|");
      if (pipeIdx === -1) continue;

      const eventTypes = trimmed.slice(0, pipeIdx).toUpperCase();
      const fullPath = trimmed.slice(pipeIdx + 1);

      // Strip /workspace/ prefix to get workspace-relative path
      const prefix = root.endsWith("/") ? root : root + "/";
      if (!fullPath.startsWith(prefix)) continue;
      const relPath = fullPath.slice(prefix.length);
      if (!relPath) continue; // root itself, ignore

      const isDelete = eventTypes.includes("DELETE") || eventTypes.includes("MOVED_FROM");

      if (isDelete) {
        onEvent({ kind: "delete", path: relPath });
      } else {
        // create, modify, moved_to → upsert (need to stat)
        statInContainer(containerName, fullPath).then((stat) => {
          if (stat === null) {
            // Directory or gone — ignore
            return;
          }
          if (stat.size > WATCHER_CONFIG.maxFileBytes) {
            watcherLog.warn("file too large, dropping watcher event", { path: relPath, size: stat.size });
            return;
          }
          onEvent({ kind: "upsert", path: relPath, size: stat.size, mtime: stat.mtime });
        }).catch(() => {});
      }
    }
  });

  proc.stderr.on("data", (chunk: Buffer) => {
    const msg = chunk.toString().trim();
    // inotifywait prints "Setting up watches..." to stderr on startup — not an error
    if (!msg.includes("Setting up watches") && !msg.includes("Watches established")) {
      watcherLog.debug("inotifywait stderr", { msg: msg.slice(0, 200) });
    }
  });

  proc.on("close", (code) => {
    onExit(code);
  });

  proc.on("error", (err) => {
    watcherLog.warn("inotifywait process error", { containerName, error: String(err) });
    onExit(null);
  });

  return proc;
}

function startFsWatcher(
  containerName: string,
  root: string,
  onEvent: (event: WatcherEvent) => void,
): fs.FSWatcher {
  watcherLog.info("falling back to fs.watch (inotifywait unavailable)", { containerName, root });
  const watcher = fs.watch(root, { recursive: true }, (_eventType, filename) => {
    if (!filename) return;
    // Filter excludes
    for (const ex of WATCHER_CONFIG.excludes) {
      if (filename.includes(ex)) return;
    }
    const absPath = `${root}/${filename}`;
    try {
      const stat = fs.statSync(absPath);
      if (stat.isDirectory()) return;
      if (stat.size > WATCHER_CONFIG.maxFileBytes) {
        watcherLog.warn("file too large, dropping watcher event", { path: filename, size: stat.size });
        return;
      }
      onEvent({ kind: "upsert", path: filename, size: stat.size, mtime: stat.mtimeMs });
    } catch {
      // File gone
      onEvent({ kind: "delete", path: filename });
    }
  });
  return watcher;
}

/**
 * Check whether inotifywait is available in the container.
 */
async function hasInotifywait(containerName: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("docker", ["exec", containerName, "which", "inotifywait"]);
    proc.on("close", (code) => resolve(code === 0));
    proc.on("error", () => resolve(false));
  });
}

/**
 * Poll until `rootDir` exists inside the container or the deadline passes.
 */
async function waitForWorkspaceDir(containerName: string, rootDir: string, maxWaitMs: number): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  const intervalMs = 250;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const proc = spawn("docker", ["exec", containerName, "test", "-d", rootDir]);
      proc.on("close", (code) => resolve(code === 0));
      proc.on("error", () => resolve(false));
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

export function startWatcher(containerName: string, root = "/workspace"): WatcherHandle {
  const subscribers = new Set<(event: WatcherEvent) => void>();
  const pending = new Map<string, PendingEntry>();
  let stopped = false;

  let inotifyProc: ReturnType<typeof spawn> | null = null;
  let fsWatcher: fs.FSWatcher | null = null;
  let crashCount = 0;
  let firstCrashAt = 0;
  const MAX_CRASHES = 5;
  const CRASH_WINDOW_MS = 60_000;
  const RESTART_DELAY_MS = 2_000;

  function deliver(event: WatcherEvent): void {
    const key = event.path;
    const existing = pending.get(key);
    if (existing) {
      clearTimeout(existing.timer);
    }
    const timer = setTimeout(() => {
      pending.delete(key);
      if (stopped) return;
      for (const fn of subscribers) {
        try { fn(event); } catch {}
      }
    }, WATCHER_CONFIG.debounceMs);
    pending.set(key, { timer, pending: event });
  }

  function launchInotify(): void {
    if (stopped) return;
    inotifyProc = startInotifyWatcher(containerName, root, deliver, (code) => {
      if (stopped) return;
      watcherLog.warn("inotifywait exited", { containerName, code });

      // Track crashes within a rolling window
      const now = Date.now();
      if (now - firstCrashAt > CRASH_WINDOW_MS) {
        crashCount = 0;
        firstCrashAt = now;
      }
      crashCount++;

      if (crashCount >= MAX_CRASHES) {
        watcherLog.warn("inotifywait crashed too many times, giving up", { containerName, crashes: crashCount });
        return;
      }

      watcherLog.info("restarting inotifywait", { containerName, attempt: crashCount, delayMs: RESTART_DELAY_MS });
      setTimeout(launchInotify, RESTART_DELAY_MS);
    });
  }

  // Async startup: probe for inotifywait, then pick implementation
  (async () => {
    if (stopped) return;
    try {
      const available = await hasInotifywait(containerName);
      if (stopped) return;
      if (available) {
        // Gate on /workspace existing so cold-start races don't burn the 5x crash cap.
        const ready = await waitForWorkspaceDir(containerName, root, 10_000);
        if (stopped) return;
        if (!ready) {
          watcherLog.warn("workspace dir probe timed out, starting inotifywait anyway", { containerName, root });
        }
        watcherLog.info("starting inotifywait watcher", { containerName, root });
        launchInotify();
      } else {
        watcherLog.warn("inotifywait not found in container, using fs.watch fallback", { containerName });
        // fs.watch fallback only works if root is accessible from the host
        try {
          fsWatcher = startFsWatcher(containerName, root, deliver);
        } catch (err) {
          watcherLog.warn("fs.watch fallback also failed", { containerName, error: String(err) });
        }
      }
    } catch (err) {
      watcherLog.warn("watcher startup error", { containerName, error: String(err) });
    }
  })();

  return {
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },

    flush(): Promise<void> {
      // Fire all pending timers immediately
      for (const [key, entry] of pending) {
        clearTimeout(entry.timer);
        pending.delete(key);
        if (!stopped) {
          for (const fn of subscribers) {
            try { fn(entry.pending); } catch {}
          }
        }
      }
      return Promise.resolve();
    },

    stop(): void {
      stopped = true;
      // Clear all pending timers
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
      }
      pending.clear();
      subscribers.clear();
      if (inotifyProc) {
        try { inotifyProc.kill(); } catch {}
        inotifyProc = null;
      }
      if (fsWatcher) {
        try { fsWatcher.close(); } catch {}
        fsWatcher = null;
      }
    },
  };
}
