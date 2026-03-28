import * as path from "node:path";
import * as fs from "node:fs/promises";

const MAX_OUTPUT_BYTES = 1_048_576; // 1 MB

export interface WorkerResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function runCodeInWorker(
  workspaceDir: string,
  timeout: number,
  entrypoint: string,
): Promise<WorkerResult> {
  const cwd = path.resolve(workspaceDir);
  const file = path.resolve(cwd, entrypoint);
  const tmpDir = path.join(cwd, ".tmp");
  await fs.mkdir(tmpDir, { recursive: true });
  const tmpFile = path.join(tmpDir, `_worker_${Date.now()}.ts`);

  // Minimal wrapper: capture console output, import the entrypoint, report back
  await fs.writeFile(tmpFile, `
const __out: string[] = [];
const __err: string[] = [];
const __fmt = (...args: any[]) => args.map(a => typeof a === "string" ? a : JSON.stringify(a, null, 2)).join(" ");
console.log = (...args: any[]) => __out.push(__fmt(...args));
console.info = (...args: any[]) => __out.push(__fmt(...args));
console.error = (...args: any[]) => __err.push(__fmt(...args));
console.warn = (...args: any[]) => __err.push(__fmt(...args));

process.chdir(${JSON.stringify(cwd)});

let exitCode = 0;
try {
  await import(${JSON.stringify(file)});
} catch (err: any) {
  __err.push(String(err?.stack ?? err));
  exitCode = 1;
}

const MAX = ${MAX_OUTPUT_BYTES};
const stdout = __out.join("\\n");
const stderr = __err.join("\\n");
postMessage({
  type: "done",
  stdout: stdout.length > MAX ? stdout.slice(0, MAX) + "\\n[truncated]" : stdout,
  stderr: stderr.length > MAX ? stderr.slice(0, MAX) + "\\n[truncated]" : stderr,
  exitCode,
});
`);

  const worker = new Worker(tmpFile, { type: "module" });

  return new Promise<WorkerResult>((resolve) => {
    const timer = setTimeout(() => {
      worker.terminate();
      cleanup();
      resolve({ stdout: "", stderr: `Code execution timed out after ${timeout / 1000}s`, exitCode: -1 });
    }, timeout);

    function cleanup() {
      clearTimeout(timer);
      fs.unlink(tmpFile).catch(() => {});
    }

    worker.onmessage = (event: MessageEvent) => {
      if (event.data?.type === "done") {
        cleanup();
        worker.terminate();
        resolve({ stdout: event.data.stdout ?? "", stderr: event.data.stderr ?? "", exitCode: event.data.exitCode ?? 0 });
      }
    };

    worker.onerror = (event: ErrorEvent) => {
      cleanup();
      worker.terminate();
      resolve({ stdout: "", stderr: event.message ?? "Worker error", exitCode: 1 });
    };
  });
}
