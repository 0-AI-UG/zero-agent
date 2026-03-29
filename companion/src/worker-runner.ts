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

  // Wrapper: patch fs and Bun.file so absolute paths resolve relative to cwd,
  // capture console output, import the entrypoint, report back
  await fs.writeFile(tmpFile, `
import nodePath from "node:path";
import nodeFs from "node:fs";
import nodeFsPromises from "node:fs/promises";

const __cwd = ${JSON.stringify(cwd)};

function __rewrite(p: string | URL): string | URL {
  if (typeof p === "string" && nodePath.isAbsolute(p)) {
    return nodePath.join(__cwd, p.replace(/^\\/+/, ""));
  }
  return p;
}

// Patch fs sync methods
const __fsSyncMethods = [
  "readFileSync", "writeFileSync", "appendFileSync", "existsSync",
  "statSync", "lstatSync", "readdirSync", "mkdirSync", "rmdirSync",
  "unlinkSync", "renameSync", "copyFileSync", "accessSync",
  "createReadStream", "createWriteStream",
] as const;

for (const method of __fsSyncMethods) {
  const orig = (nodeFs as any)[method];
  if (typeof orig === "function") {
    (nodeFs as any)[method] = (p: any, ...args: any[]) => orig(__rewrite(p), ...args);
  }
}

// Patch fs/promises methods
const __fsAsyncMethods = [
  "readFile", "writeFile", "appendFile", "stat", "lstat",
  "readdir", "mkdir", "rmdir", "unlink", "rename", "copyFile",
  "access", "rm",
] as const;

for (const method of __fsAsyncMethods) {
  const orig = (nodeFsPromises as any)[method];
  if (typeof orig === "function") {
    (nodeFsPromises as any)[method] = (p: any, ...args: any[]) => orig(__rewrite(p), ...args);
  }
}

// Patch Bun.file
const __origBunFile = Bun.file.bind(Bun);
(Bun as any).file = (p: any, ...args: any[]) => __origBunFile(__rewrite(p), ...args);

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
