import * as path from "node:path";
import * as os from "node:os";
import type { WorkerResult } from "./worker-runner.ts";
import { readCapped } from "./workspace-utils.ts";
import { ensureUv } from "./uv-manager.ts";

const MAX_OUTPUT_BYTES = 1_048_576; // 1 MB

export async function runCodeInPython(
  workspaceDir: string,
  timeout: number,
  entrypoint: string,
): Promise<WorkerResult> {
  const uvPath = await ensureUv();
  const cwd = path.resolve(workspaceDir);
  const file = path.resolve(cwd, entrypoint);

  const proc = Bun.spawn([uvPath, "run", file], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: "1",
      UV_PYTHON_PREFERENCE: "only-managed",
      UV_CACHE_DIR: path.join(os.homedir(), ".companion", "uv", "cache"),
    },
  });

  const timer = setTimeout(() => {
    proc.kill();
  }, timeout);

  try {
    const [stdout, stderr] = await Promise.all([
      readCapped(proc.stdout, MAX_OUTPUT_BYTES),
      readCapped(proc.stderr, MAX_OUTPUT_BYTES),
    ]);

    const exitCode = await proc.exited;
    clearTimeout(timer);

    return { stdout, stderr, exitCode };
  } catch (err) {
    clearTimeout(timer);
    const message = err instanceof Error ? err.message : String(err);
    return { stdout: "", stderr: message, exitCode: 1 };
  }
}
