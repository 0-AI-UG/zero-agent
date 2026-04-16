/**
 * Ports handler - forward a workspace port to a browser-accessible URL.
 *
 * Migrated from the old in-process `forwardPort` AI tool in
 * server/tools/apps.ts. The agent now invokes this via
 * `zero ports forward <port>` from inside its container, matching every
 * other capability (browser, creds, telegram, …).
 */
import type { z } from "zod";
import { nanoid } from "nanoid";
import { log } from "@/lib/utils/logger.ts";
import {
  insertPort,
  getPortByProjectAndPort,
} from "@/db/queries/apps.ts";
import { getLocalBackend } from "@/lib/execution/lifecycle.ts";
import type { ExecutionBackend } from "@/lib/execution/backend-interface.ts";
import type { CliContext } from "./context.ts";
import { ok, fail } from "./response.ts";
import type { PortsForwardInput } from "zero/schemas";

const handlerLog = log.child({ module: "cli:ports" });

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32)
    + "-" + nanoid(4).toLowerCase();
}

function buildAppUrl(slug: string): string {
  const base = process.env.APP_URL?.replace(/\/+$/, "");
  return base ? `${base}/app/${slug}` : `/app/${slug}`;
}

/**
 * Auto-detect the start command for a process listening on a given port.
 * Runs netstat/ss + /proc inspection inside the container. Best-effort -
 * returns null if nothing is listening or the container lacks the tools.
 */
async function detectStartCommand(
  backend: ExecutionBackend,
  projectId: string,
  port: number,
): Promise<{ command: string; cwd: string } | null> {
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

export async function handlePortsForward(
  ctx: CliContext,
  input: z.infer<typeof PortsForwardInput>,
): Promise<Response> {
  const { port, label } = input;
  handlerLog.info("forwardPort", { userId: ctx.userId, projectId: ctx.projectId, port, label });

  const backend = getLocalBackend();
  if (!backend) {
    return fail("no_backend", "Execution backend is not available", 503);
  }

  let session = backend.getSessionForProject(ctx.projectId);
  if (!session) {
    const exists = await backend.hasContainer(ctx.projectId);
    if (!exists) {
      return fail("no_session", "No active session. Run a command first to start a session.", 409);
    }
    session = await backend.ensureSessionForProject(ctx.projectId, ctx.userId);
  }

  // Idempotency - return the existing forward if one exists for this port.
  const existing = getPortByProjectAndPort(ctx.projectId, port);
  if (existing) {
    const existingUrl = buildAppUrl(existing.slug);
    return ok({
      portId: existing.id,
      url: existingUrl,
      slug: existing.slug,
      port,
      message: `Port ${port} is already forwarded at ${existingUrl}`,
    });
  }

  const detected = await detectStartCommand(backend, ctx.projectId, port);

  const portLabel = label || `Port ${port}`;
  const slug = slugify(portLabel);

  const record = insertPort(ctx.projectId, ctx.userId, slug, port, {
    label: portLabel,
    containerIp: session.containerIp,
    startCommand: detected?.command,
    workingDir: detected?.cwd ?? "/workspace",
  });

  handlerLog.info("port forwarded", { portId: record.id, slug, port, detectedCommand: detected?.command });

  const url = buildAppUrl(slug);
  return ok({
    portId: record.id,
    url,
    slug,
    port,
    message: `Port ${port} is now accessible at ${url}`,
  });
}
