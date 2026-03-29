import type { ExecutionBackend } from "./workspace.ts";
import { readCapped } from "./workspace-utils.ts";

const IMAGE = "zero-workspace:latest";
const MAX_OUTPUT = 1_048_576; // 1 MB

const DOCKERFILE = `
FROM oven/bun:latest

RUN apt-get update && apt-get install -y --no-install-recommends \\
    curl git jq zip unzip imagemagick ca-certificates \\
    && curl -LsSf https://astral.sh/uv/install.sh | sh \\
    && mv /root/.local/bin/uv /usr/local/bin/uv \\
    && rm -rf /var/lib/apt/lists/*

ENV UV_PYTHON_PREFERENCE=only-managed
WORKDIR /workspace
`.trim();

export class DockerBackend implements ExecutionBackend {
  private containers = new Map<string, string>(); // workspaceId → containerId
  private imageReady = false;
  private imageBuilding: Promise<void> | null = null;

  /** Build/ensure the workspace image exists. Called once lazily. */
  private async ensureImage(): Promise<void> {
    if (this.imageReady) return;
    if (this.imageBuilding) return this.imageBuilding;

    this.imageBuilding = (async () => {
      // Check if image already exists
      const check = Bun.spawnSync(["docker", "image", "inspect", IMAGE], {
        stdout: "pipe",
        stderr: "pipe",
      });
      if (check.exitCode === 0) {
        this.imageReady = true;
        return;
      }

      // Build image from inline Dockerfile via stdin
      const build = Bun.spawn(
        ["docker", "build", "-t", IMAGE, "-"],
        { stdout: "pipe", stderr: "pipe", stdin: "pipe" },
      );
      build.stdin.write(DOCKERFILE);
      build.stdin.end();
      const exitCode = await build.exited;
      if (exitCode !== 0) {
        const stderr = await new Response(build.stderr).text();
        throw new Error(`Failed to build workspace image: ${stderr}`);
      }
      this.imageReady = true;
    })();

    return this.imageBuilding;
  }

  async initWorkspace(workspaceId: string, dir: string): Promise<void> {
    await this.ensureImage();

    const containerName = `workspace-${workspaceId}`;

    // Remove any leftover container with the same name
    Bun.spawnSync(["docker", "rm", "-f", containerName], {
      stdout: "ignore",
      stderr: "ignore",
    });

    const proc = Bun.spawn(
      [
        "docker", "run", "-d",
        "--name", containerName,
        "-v", `${dir}:/workspace`,
        "--workdir", "/workspace",
        IMAGE,
        "sleep", "infinity",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const containerId = (await new Response(proc.stdout).text()).trim();
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`Failed to start workspace container: ${stderr}`);
    }
    this.containers.set(workspaceId, containerId);
  }

  async runCommand(
    workspaceId: string,
    _dir: string,
    command: string,
    timeout: number,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const containerId = this.containers.get(workspaceId);
    if (!containerId) throw new Error("Container not found for workspace");

    const proc = Bun.spawn(
      ["docker", "exec", containerId, "bash", "-c", command],
      { stdout: "pipe", stderr: "pipe" },
    );
    const timer = setTimeout(() => {
      proc.kill();
    }, timeout);
    const [stdout, stderr] = await Promise.all([
      readCapped(proc.stdout, MAX_OUTPUT),
      readCapped(proc.stderr, MAX_OUTPUT),
    ]);
    clearTimeout(timer);
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  }

  async destroyWorkspace(workspaceId: string): Promise<void> {
    const containerId = this.containers.get(workspaceId);
    if (!containerId) return;
    this.containers.delete(workspaceId);
    Bun.spawn(["docker", "rm", "-f", containerId], {
      stdout: "ignore",
      stderr: "ignore",
    });
  }
}
