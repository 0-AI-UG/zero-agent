import { spawn, spawnSync } from "node:child_process";

export interface DockerExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Run `docker exec <name> <argv...>` and return the result. */
export function dockerExec(name: string, argv: string[], opts?: { timeoutMs?: number }): Promise<DockerExecResult> {
  return new Promise((resolve) => {
    const proc = spawn("docker", ["exec", name, ...argv], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    const timer = opts?.timeoutMs
      ? setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, opts.timeoutMs)
      : null;
    proc.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
    proc.on("error", () => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr: stderr || "spawn error", exitCode: -1 });
    });
  });
}

/** True if a docker container by that name currently exists (any state). */
export function containerExists(name: string): boolean {
  const res = spawnSync(
    "docker",
    ["ps", "-aq", "--filter", `name=^${name}$`],
    { encoding: "utf8" },
  );
  return Boolean((res.stdout ?? "").trim());
}

/** Returns the parsed `docker inspect` JSON for the container, or null. */
export function dockerInspect(name: string): Record<string, unknown> | null {
  const res = spawnSync("docker", ["inspect", name], { encoding: "utf8" });
  if (res.status !== 0) return null;
  try {
    const arr = JSON.parse(res.stdout) as Record<string, unknown>[];
    return arr[0] ?? null;
  } catch {
    return null;
  }
}

/** Force-remove a container (silent on failure). */
export function forceRemove(name: string): void {
  spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
}

/** Force-remove every container whose name starts with `prefix`. */
export function forceRemoveByPrefix(prefix: string): void {
  const res = spawnSync(
    "docker",
    ["ps", "-aq", "--filter", `name=${prefix}`],
    { encoding: "utf8" },
  );
  const ids = (res.stdout ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (ids.length === 0) return;
  spawnSync("docker", ["rm", "-f", ...ids], { stdio: "ignore" });
}
