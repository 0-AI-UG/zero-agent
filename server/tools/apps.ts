import { z } from "zod";
import { tool } from "ai";
import { log } from "@/lib/logger.ts";
import { nanoid } from "nanoid";
import {
  insertPort,
  getPortByProjectAndPort,
} from "@/db/queries/apps.ts";
import type { ExecutionBackend } from "@/lib/execution/backend-interface.ts";

const toolLog = log.child({ module: "tool:ports" });

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32)
    + "-" + nanoid(4).toLowerCase();
}

let _getBackend: (() => ExecutionBackend | null) | null = null;

export function setBackendGetter(getter: (() => ExecutionBackend | null) | null): void {
  _getBackend = getter;
}

/**
 * Auto-detect the start command for a process listening on a given port.
 * Runs ss + /proc inspection inside the container.
 */
async function detectStartCommand(backend: ExecutionBackend, projectId: string, port: number): Promise<{ command: string; cwd: string } | null> {
  try {
    let pid: string | null = null;

    const netstatResult = await backend.execInContainer(projectId, [
      "bash", "-c",
      `netstat -tlnp 2>/dev/null | grep -E ':${port}\\b' | head -1 | sed 's|.* \\([0-9]*\\)/.*|\\1|'`,
    ], { timeout: 5_000 });
    pid = netstatResult.stdout.trim() || null;

    if (!pid) {
      const ssResult = await backend.execInContainer(projectId, [
        "bash", "-c",
        `ss -tlnp 2>/dev/null | grep -E ':${port}\\b' | head -1 | grep -oP 'pid=\\K[0-9]+'`,
      ], { timeout: 5_000 });
      pid = ssResult.stdout.trim() || null;
    }

    if (!pid) {
      const hexPort = port.toString(16).toUpperCase().padStart(4, "0");
      const procResult = await backend.execInContainer(projectId, [
        "bash", "-c",
        `grep -i ':${hexPort} ' /proc/net/tcp /proc/net/tcp6 2>/dev/null | grep ' 0A ' | head -1 | awk '{print $10}'`,
      ], { timeout: 5_000 });
      const inode = procResult.stdout.trim();
      if (inode && inode !== "0") {
        const pidResult = await backend.execInContainer(projectId, [
          "bash", "-c",
          `for p in /proc/[0-9]*/fd/*; do readlink "$p" 2>/dev/null | grep -q "socket:\\[${inode}\\]" && echo "$p" | cut -d/ -f3 && break; done`,
        ], { timeout: 5_000 });
        pid = pidResult.stdout.trim() || null;
      }
    }

    if (!pid) return null;

    const [cmdResult, cwdResult] = await Promise.all([
      backend.execInContainer(projectId, ["bash", "-c", `cat /proc/${pid}/cmdline 2>/dev/null | tr '\\0' ' '`], { timeout: 5_000 }),
      backend.execInContainer(projectId, ["bash", "-c", `readlink /proc/${pid}/cwd 2>/dev/null`], { timeout: 5_000 }),
    ]);

    const command = cmdResult.stdout.trim();
    const cwd = cwdResult.stdout.trim() || "/workspace";

    return command ? { command, cwd } : null;
  } catch {
    return null;
  }
}

export function createPortTools(userId: string, projectId: string) {
  return {
    forwardPort: tool({
      description:
        "Forward a port from the workspace to a browser-accessible URL.\n" +
        "Call this after starting a server with the bash tool (using background: true).\n" +
        "Returns a URL that proxies to the given port.\n" +
        "If the port is already forwarded, returns the existing URL.",
      inputSchema: z.object({
        port: z.number().int().min(1).max(65535).describe("Port number to forward"),
        label: z.string().max(100).optional().describe("Short label (e.g. 'React dev server')"),
      }),
      execute: async ({ port, label }) => {
        toolLog.info("forwardPort", { userId, projectId, port, label });

        const backend = _getBackend?.();
        if (!backend) {
          return { error: "Execution backend is not available." };
        }

        let session = backend.getSessionForProject(projectId);
        if (!session) {
          // Cache may have expired — check if container is actually running
          const exists = await backend.hasContainer(projectId);
          if (!exists) {
            return { error: "No active session. Run a command first to start a session." };
          }
          session = await backend.ensureSessionForProject(projectId, userId);
        }

        try {
          // Check if port already forwarded — return existing URL
          const existing = getPortByProjectAndPort(projectId, port);
          if (existing) {
            return {
              portId: existing.id,
              url: `/app/${existing.slug}`,
              slug: existing.slug,
              port,
              message: `Port ${port} is already forwarded at /app/${existing.slug}`,
            };
          }

          // Auto-detect start command from running process
          const detected = await detectStartCommand(backend, projectId, port);

          const portLabel = label || `Port ${port}`;
          const slug = slugify(portLabel);

          const record = insertPort(projectId, userId, slug, port, {
            label: portLabel,
            containerIp: session.containerIp,
            startCommand: detected?.command,
            workingDir: detected?.cwd ?? "/workspace",
          });

          toolLog.info("port forwarded", { portId: record.id, slug, port, detectedCommand: detected?.command });

          return {
            portId: record.id,
            url: `/app/${slug}`,
            slug,
            port,
            message: `Port ${port} is now accessible at /app/${slug}`,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          toolLog.error("forwardPort failed", err, { userId, projectId });
          return { error: message };
        }
      },
    }),
  };
}
