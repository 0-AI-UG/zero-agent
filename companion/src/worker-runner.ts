import * as path from "node:path";
import * as fs from "node:fs/promises";

const MAX_OUTPUT_BYTES = 1_048_576; // 1 MB

export interface WorkerResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run JS/TS code in a Bun Worker thread.
 * Captures console.log → stdout, console.error/warn → stderr.
 * Blocks Bun.spawn/spawnSync, sandboxes filesystem, sanitizes env.
 */
export async function runCodeInWorker(
  code: string | null,
  workspaceDir: string,
  timeout: number,
  entrypoint?: string,
): Promise<WorkerResult> {
  const resolvedWorkspace = path.resolve(workspaceDir);

  // Build the user code section — either inline or dynamic import
  let userCodeSection: string;
  if (entrypoint) {
    const resolvedEntry = path.resolve(resolvedWorkspace, path.basename(entrypoint));
    // Use the full entrypoint path provided (already validated by workspace.ts)
    userCodeSection = `    await import(${JSON.stringify(entrypoint)});`;
  } else if (code) {
    userCodeSection = code.split("\n").map(line => "    " + line).join("\n");
  } else {
    throw new Error("Either code or entrypoint must be provided");
  }

  const wrapperCode = `
// ── Worker bootstrap ──
const __stdout = [];
const __stderr = [];
let __stdoutBytes = 0;
let __stderrBytes = 0;
const __MAX = ${MAX_OUTPUT_BYTES};

function __cap(arr, counter, args) {
  const line = args.map(a => typeof a === "string" ? a : JSON.stringify(a, null, 2)).join(" ");
  if (counter.val < __MAX) {
    arr.push(line);
    counter.val += line.length;
  }
  return counter;
}

const __outCounter = { val: 0 };
const __errCounter = { val: 0 };

console.log = (...args) => __cap(__stdout, __outCounter, args);
console.info = (...args) => __cap(__stdout, __outCounter, args);
console.error = (...args) => __cap(__stderr, __errCounter, args);
console.warn = (...args) => __cap(__stderr, __errCounter, args);

// ── Security: Block subprocesses ──
if (typeof Bun !== "undefined") {
  Bun.spawn = () => { throw new Error("Bun.spawn is blocked in sandbox"); };
  Bun.spawnSync = () => { throw new Error("Bun.spawnSync is blocked in sandbox"); };
}

// ── Security: Filesystem sandbox ──
const __workspaceDir = ${JSON.stringify(resolvedWorkspace)};
const __workspacePrefix = __workspaceDir + "/";

function __assertInWorkspace(p) {
  // Resolve from workspace dir for relative paths
  const resolved = p.startsWith("/") ? p : __workspaceDir + "/" + p;
  // Normalize to remove .. etc
  const segments = resolved.split("/");
  const normalized = [];
  for (const s of segments) {
    if (s === "..") normalized.pop();
    else if (s !== "." && s !== "") normalized.push(s);
  }
  const final = "/" + normalized.join("/");
  if (final !== __workspaceDir && !final.startsWith(__workspacePrefix)) {
    throw new Error("Filesystem access denied: path outside workspace");
  }
  return final;
}

// Wrap Bun.file and Bun.write
if (typeof Bun !== "undefined") {
  const __origFile = Bun.file.bind(Bun);
  Bun.file = (p, ...rest) => {
    if (typeof p === "string") __assertInWorkspace(p);
    return __origFile(p, ...rest);
  };
  const __origWrite = Bun.write.bind(Bun);
  Bun.write = (dest, ...rest) => {
    if (typeof dest === "string") __assertInWorkspace(dest);
    return __origWrite(dest, ...rest);
  };
}

// Wrap node:fs methods
try {
  const __fs = require("node:fs");
  const __fsp = require("node:fs/promises");
  const __fsMethodsSync = ["readFileSync", "writeFileSync", "appendFileSync", "mkdirSync", "rmdirSync",
    "unlinkSync", "readdirSync", "statSync", "lstatSync", "existsSync", "copyFileSync", "renameSync",
    "chmodSync", "chownSync", "accessSync"];
  const __fsMethods = ["readFile", "writeFile", "appendFile", "mkdir", "rmdir", "unlink", "readdir",
    "stat", "lstat", "copyFile", "rename", "chmod", "chown", "access", "rm", "open"];

  for (const m of __fsMethodsSync) {
    if (typeof __fs[m] === "function") {
      const orig = __fs[m].bind(__fs);
      __fs[m] = (p, ...rest) => {
        if (typeof p === "string") __assertInWorkspace(p);
        return orig(p, ...rest);
      };
    }
  }
  for (const m of __fsMethods) {
    if (typeof __fsp[m] === "function") {
      const orig = __fsp[m].bind(__fsp);
      __fsp[m] = (p, ...rest) => {
        if (typeof p === "string") __assertInWorkspace(p);
        return orig(p, ...rest);
      };
    }
  }
} catch {}

// ── Security: Sanitize process.env ──
{
  const __keepKeys = new Set(["HOME", "PATH", "NODE_ENV", "TERM"]);
  for (const key of Object.keys(process.env)) {
    if (!__keepKeys.has(key)) {
      delete process.env[key];
    }
  }
  process.env.HOME = __workspaceDir;
  process.env.NODE_ENV = "production";
}

// ── Security: Block process.exit / process.kill ──
process.exit = () => { throw new Error("process.exit is blocked in sandbox"); };
process.kill = () => { throw new Error("process.kill is blocked in sandbox"); };

process.chdir(${JSON.stringify(resolvedWorkspace)});

(async () => {
  let exitCode = 0;
  try {
${userCodeSection}
  } catch (err) {
    __stderr.push(String(err?.stack ?? err));
    exitCode = 1;
  }

  const stdout = __stdout.join("\\n");
  const stderr = __stderr.join("\\n");
  postMessage({
    type: "done",
    stdout: stdout.length > __MAX ? stdout.slice(0, __MAX) + "\\n[output truncated at 1MB]" : stdout,
    stderr: stderr.length > __MAX ? stderr.slice(0, __MAX) + "\\n[output truncated at 1MB]" : stderr,
    exitCode,
  });
})();
`;

  // Try Blob-based worker first, fall back to file-based
  let worker: Worker;
  let tmpFile: string | null = null;

  try {
    worker = new Worker(new Blob([wrapperCode]) as any, { type: "module" });
  } catch {
    // Blob-based Workers may not work in compiled binaries — use file fallback
    const tmpDir = path.join(workspaceDir, ".tmp");
    await fs.mkdir(tmpDir, { recursive: true });
    tmpFile = path.join(tmpDir, `_worker_${Date.now()}.ts`);
    await fs.writeFile(tmpFile, wrapperCode);
    worker = new Worker(tmpFile, { type: "module" });
  }

  return new Promise<WorkerResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.terminate();
      cleanup();
      resolve({
        stdout: "",
        stderr: `Code execution timed out after ${timeout / 1000}s`,
        exitCode: -1,
      });
    }, timeout);

    function cleanup() {
      clearTimeout(timer);
      if (tmpFile) {
        fs.unlink(tmpFile).catch(() => {});
      }
    }

    worker.onmessage = (event: MessageEvent) => {
      if (event.data?.type === "done") {
        cleanup();
        worker.terminate();
        resolve({
          stdout: event.data.stdout ?? "",
          stderr: event.data.stderr ?? "",
          exitCode: event.data.exitCode ?? 0,
        });
      }
    };

    worker.onerror = (event: ErrorEvent) => {
      cleanup();
      worker.terminate();
      resolve({
        stdout: "",
        stderr: event.message ?? "Worker error",
        exitCode: 1,
      });
    };
  });
}
