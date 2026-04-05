/**
 * Port Manager — handles cold-start restart of pinned ports and reconciliation.
 * Processes are started by the bash tool; this only manages restart for pinned services.
 */
import { log } from "@/lib/logger.ts";
import {
  getAllActivePorts,
  getActivePortsByProject,
  getPinnedPortsByProject,
  updatePort,
} from "@/db/queries/apps.ts";
import { invalidateAppCache } from "@/lib/app-proxy.ts";
import { docker } from "@/lib/docker-client.ts";

const portLog = log.child({ module: "port-manager" });

export class PortManager {
  private healthInterval: ReturnType<typeof setInterval> | null = null;
  private getBackend: () => import("./local-backend.ts").LocalBackend | null;

  constructor(getBackend: () => import("./local-backend.ts").LocalBackend | null) {
    this.getBackend = getBackend;
  }

  async init(): Promise<void> {
    await this.reconcile();
    this.healthInterval = setInterval(() => this.healthCheck(), 60_000);
    portLog.info("port manager initialized");
  }

  stop(): void {
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
      this.healthInterval = null;
    }
  }

  /**
   * Restart pinned ports for a project after session resume.
   * Runs each pinned port's start_command in the session container.
   */
  async restartPinnedForProject(projectId: string, containerName: string, containerIp: string): Promise<void> {
    const ports = getPinnedPortsByProject(projectId);
    const restartable = ports.filter(p => p.start_command);
    if (restartable.length === 0) return;

    portLog.info("restarting pinned ports after session resume", { projectId, count: restartable.length });

    for (const port of restartable) {
      try {
        const workingDir = port.working_dir || "/workspace";
        const envVars: Record<string, string> = JSON.parse(port.env_vars || "{}");
        const envExports = [`PORT=${port.port}`, ...Object.entries(envVars).map(([k, v]) => `${k}=${v}`)].map(
          (e) => `export ${e}`
        ).join(" && ");

        const cmd = [
          "bash", "-c",
          `cd ${workingDir} && ${envExports} && nohup bash -c '${port.start_command!.replace(/'/g, "'\\''")}' > /tmp/port-${port.port}.log 2>&1 & echo $!`,
        ];

        const result = await docker.exec(containerName, cmd, { timeout: 15_000 });
        const pid = result.stdout.trim();

        if (pid && result.exitCode === 0) {
          const ready = await this.waitForPort(containerIp, port.port, 15_000);
          if (ready) {
            updatePort(port.id, { container_ip: containerIp, status: "active" });
            invalidateAppCache(port.slug);
            portLog.info("pinned port restarted", { portId: port.id, slug: port.slug, port: port.port, pid });
          } else {
            portLog.warn("pinned port process started but not listening", { portId: port.id, slug: port.slug, port: port.port, pid });
          }
        } else {
          portLog.warn("failed to restart pinned port", { portId: port.id, slug: port.slug, stderr: result.stderr });
        }
      } catch (err) {
        portLog.warn("error restarting pinned port", { portId: port.id, slug: port.slug, error: String(err) });
      }
    }
  }

  /**
   * Cold-start a single pinned port (called from proxy on first access).
   */
  async coldStartPort(portId: string, projectId: string): Promise<{ success: boolean; error?: string }> {
    const { getPortById } = await import("@/db/queries/apps.ts");
    const port = getPortById(portId);
    if (!port) return { success: false, error: "Port not found" };

    const backend = this.getBackend();
    if (!backend) return { success: false, error: "Execution backend not available" };

    // Ensure session container exists (creates one if destroyed)
    await backend.ensureSessionForProject(projectId, port.user_id);
    const session = backend.getSessionForProject(projectId);
    if (!session) return { success: false, error: "Could not create session" };

    // Sync workspace files so the start command has something to run
    const { buildFileManifest } = await import("@/tools/code.ts");
    const manifest = buildFileManifest(projectId);
    await backend.syncProjectFiles(projectId, manifest);

    // If we have a start command, run it
    if (port.start_command) {
      const workingDir = port.working_dir || "/workspace";
      const envVars: Record<string, string> = JSON.parse(port.env_vars || "{}");
      const envExports = [`PORT=${port.port}`, ...Object.entries(envVars).map(([k, v]) => `${k}=${v}`)].map(
        (e) => `export ${e}`
      ).join(" && ");

      const cmd = [
        "bash", "-c",
        `cd ${workingDir} && ${envExports} && nohup bash -c '${port.start_command.replace(/'/g, "'\\''")}' > /tmp/port-${port.port}.log 2>&1 & echo $!`,
      ];

      const result = await docker.exec(session.containerName, cmd, { timeout: 15_000 });
      const pid = result.stdout.trim();

      if (!pid || result.exitCode !== 0) {
        return { success: false, error: result.stderr || "Failed to start process" };
      }

      // Wait for the process to bind the port
      const ready = await this.waitForPort(session.containerIp, port.port, 15_000);
      if (!ready) {
        portLog.warn("cold-start process started but port not ready", { portId: port.id, port: port.port, pid });
        return { success: false, error: "Process started but port not listening within timeout" };
      }
    } else {
      // No start command — just ensure session is up, check if port is already listening
      const ready = await this.waitForPort(session.containerIp, port.port, 5_000);
      if (!ready) {
        return { success: false, error: "No start command saved and port is not listening. Start the server from chat." };
      }
    }

    updatePort(port.id, { container_ip: session.containerIp, status: "active", error: null });
    invalidateAppCache(port.slug);
    portLog.info("cold-start successful", { portId: port.id, slug: port.slug, port: port.port });
    return { success: true };
  }

  /**
   * Poll until a TCP port is accepting connections.
   */
  private async waitForPort(ip: string, port: number, maxWaitMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      try {
        const res = await fetch(`http://${ip}:${port}/`, { method: "HEAD", redirect: "manual" });
        // Any response (even 4xx/5xx) means the server is listening
        void res;
        return true;
      } catch {
        // Connection refused — wait and retry
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  /**
   * Mark all active ports for a project as stopped (called on session destroy).
   */
  markProjectPortsStopped(projectId: string): void {
    const ports = getActivePortsByProject(projectId);
    for (const port of ports) {
      updatePort(port.id, { status: "stopped", container_ip: null });
      invalidateAppCache(port.slug);
    }
    if (ports.length > 0) {
      portLog.info("marked ports stopped for destroyed session", { projectId, count: ports.length });
    }
  }

  /**
   * On startup, mark any ports in "active" state as stopped since we can't verify them.
   */
  private async reconcile(): Promise<void> {
    const activePorts = getAllActivePorts();
    let reconciled = 0;

    for (const port of activePorts) {
      const backend = this.getBackend();
      const session = backend?.getSessionForProject(port.project_id);

      if (!session) {
        updatePort(port.id, { status: "stopped", container_ip: null });
        invalidateAppCache(port.slug);
        reconciled++;
      }
    }

    if (reconciled > 0) {
      portLog.info("reconciliation complete", { reconciled, total: activePorts.length });
    }
  }

  /**
   * Periodic health check — verify active ports still have reachable sessions.
   */
  private async healthCheck(): Promise<void> {
    const ports = getAllActivePorts();
    for (const port of ports) {
      const backend = this.getBackend();
      const session = backend?.getSessionForProject(port.project_id);
      if (!session) {
        updatePort(port.id, { status: "stopped", container_ip: null });
        invalidateAppCache(port.slug);
        portLog.warn("health check: session gone for active port", { portId: port.id, slug: port.slug });
      }
    }
  }
}
