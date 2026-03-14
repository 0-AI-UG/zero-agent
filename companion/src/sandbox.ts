import { Subprocess } from "bun";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";

const SANDBOX_ROOT = path.join(os.homedir(), ".companion", "sandboxes");
const IDLE_TIMEOUT = 10 * 60 * 1000; // 10 minutes
const DEFAULT_SCRIPT_TIMEOUT = 60_000;
const MAX_OUTPUT_BYTES = 1_048_576; // 1 MB
const SIGKILL_DELAY = 5_000; // 5 seconds after SIGTERM
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB per file
const MAX_TOTAL_BYTES = 50 * 1024 * 1024; // 50 MB total

async function readCapped(stream: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (totalBytes + value.byteLength > maxBytes) {
        const remaining = maxBytes - totalBytes;
        if (remaining > 0) chunks.push(value.subarray(0, remaining));
        totalBytes = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(value);
      totalBytes += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(merged);
  return truncated ? text + "\n[output truncated at 1MB]" : text;
}

// Common import-name → PyPI-package mappings where they differ
const IMPORT_TO_PYPI: Record<string, string> = {
  cv2: "opencv-python",
  PIL: "pillow",
  sklearn: "scikit-learn",
  bs4: "beautifulsoup4",
  yaml: "pyyaml",
  attr: "attrs",
  dotenv: "python-dotenv",
  gi: "PyGObject",
  lxml: "lxml",
  serial: "pyserial",
  usb: "pyusb",
  wx: "wxPython",
  Crypto: "pycryptodome",
};

// Python stdlib modules — skip these when auto-detecting packages
const STDLIB = new Set([
  "__future__", "abc", "aifc", "argparse", "array", "ast", "asynchat",
  "asyncio", "asyncore", "atexit", "audioop", "base64", "bdb", "binascii",
  "binhex", "bisect", "builtins", "bz2", "calendar", "cgi", "cgitb",
  "chunk", "cmath", "cmd", "code", "codecs", "codeop", "collections",
  "colorsys", "compileall", "concurrent", "configparser", "contextlib",
  "contextvars", "copy", "copyreg", "cProfile", "crypt", "csv", "ctypes",
  "curses", "dataclasses", "datetime", "dbm", "decimal", "difflib", "dis",
  "distutils", "doctest", "email", "encodings", "enum", "errno",
  "faulthandler", "fcntl", "filecmp", "fileinput", "fnmatch", "fractions",
  "ftplib", "functools", "gc", "getopt", "getpass", "gettext", "glob",
  "grp", "gzip", "hashlib", "heapq", "hmac", "html", "http", "idlelib",
  "imaplib", "imghdr", "imp", "importlib", "inspect", "io", "ipaddress",
  "itertools", "json", "keyword", "lib2to3", "linecache", "locale",
  "logging", "lzma", "mailbox", "mailcap", "marshal", "math", "mimetypes",
  "mmap", "modulefinder", "multiprocessing", "netrc", "nis", "nntplib",
  "numbers", "operator", "optparse", "os", "ossaudiodev", "pathlib",
  "pdb", "pickle", "pickletools", "pipes", "pkgutil", "platform",
  "plistlib", "poplib", "posix", "posixpath", "pprint", "profile",
  "pstats", "pty", "pwd", "py_compile", "pyclbr", "pydoc", "queue",
  "quopri", "random", "re", "readline", "reprlib", "resource", "rlcompleter",
  "runpy", "sched", "secrets", "select", "selectors", "shelve", "shlex",
  "shutil", "signal", "site", "smtpd", "smtplib", "sndhdr", "socket",
  "socketserver", "spwd", "sqlite3", "ssl", "stat", "statistics", "string",
  "stringprep", "struct", "subprocess", "sunau", "symtable", "sys",
  "sysconfig", "syslog", "tabnanny", "tarfile", "telnetlib", "tempfile",
  "termios", "test", "textwrap", "threading", "time", "timeit", "tkinter",
  "token", "tokenize", "tomllib", "trace", "traceback", "tracemalloc",
  "tty", "turtle", "turtledemo", "types", "typing", "unicodedata",
  "unittest", "urllib", "uu", "uuid", "venv", "warnings", "wave",
  "weakref", "webbrowser", "winreg", "winsound", "wsgiref", "xdrlib",
  "xml", "xmlrpc", "zipapp", "zipfile", "zipimport", "zlib", "_thread",
]);

/**
 * Extract top-level module names from Python import statements.
 */
export function detectImports(script: string): string[] {
  const modules = new Set<string>();
  // Match: import foo / import foo.bar / from foo import ... / from foo.bar import ...
  const re = /^\s*(?:import|from)\s+([\w]+)/gm;
  let match;
  while ((match = re.exec(script)) !== null) {
    modules.add(match[1]);
  }
  return [...modules];
}

/**
 * Map detected import names to PyPI package names, skipping stdlib.
 */
export function resolvePackages(imports: string[], explicit?: string[]): string[] {
  const packages = new Set<string>(explicit ?? []);
  for (const mod of imports) {
    if (STDLIB.has(mod)) continue;
    packages.add(IMPORT_TO_PYPI[mod] ?? mod);
  }
  return [...packages];
}

interface SandboxState {
  lastUsedAt: number;
  processes: Set<Subprocess>;
}

export class SandboxManager {
  private sandboxes = new Map<string, SandboxState>();
  private reaper: ReturnType<typeof setInterval>;

  constructor() {
    this.reaper = setInterval(() => {
      const now = Date.now();
      for (const [id, state] of this.sandboxes) {
        if (now - state.lastUsedAt > IDLE_TIMEOUT) {
          console.log(`Reaping idle sandbox ${id}`);
          this.destroySandbox(id);
        }
      }
    }, 60_000);
  }

  private sandboxDir(sandboxId: string): string {
    return path.join(SANDBOX_ROOT, sandboxId);
  }

  private touch(sandboxId: string): void {
    const state = this.sandboxes.get(sandboxId);
    if (state) state.lastUsedAt = Date.now();
  }

  async createSandbox(sandboxId: string): Promise<{ pythonVersion: string | null }> {
    const dir = this.sandboxDir(sandboxId);
    await fs.mkdir(path.join(dir, "files"), { recursive: true });
    await fs.mkdir(path.join(dir, "scripts"), { recursive: true });

    this.sandboxes.set(sandboxId, { lastUsedAt: Date.now(), processes: new Set() });

    // Detect Python via uv
    let pythonVersion: string | null = null;
    try {
      const proc = Bun.spawn(["uv", "run", "python", "--version"], { stdout: "pipe", stderr: "pipe" });
      const stdout = await new Response(proc.stdout).text();
      await proc.exited;
      if (proc.exitCode === 0) {
        pythonVersion = stdout.trim().replace("Python ", "");
      }
    } catch {
      // uv or python not available
    }

    return { pythonVersion };
  }

  /** Recursively walk a directory, returning relative paths with mtime and size. */
  private async walkDir(dir: string, base: string = dir): Promise<Array<{ path: string; mtimeMs: number; size: number }>> {
    const results: Array<{ path: string; mtimeMs: number; size: number }> = [];
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...await this.walkDir(fullPath, base));
        } else if (entry.isFile()) {
          const stat = await fs.stat(fullPath);
          results.push({ path: path.relative(base, fullPath), mtimeMs: stat.mtimeMs, size: stat.size });
        }
      }
    } catch {
      // Directory doesn't exist yet — empty snapshot
    }
    return results;
  }

  /** Take a snapshot, run callback, diff snapshots, return changed files as base64. */
  private async collectChangedFiles(
    filesDir: string,
  ): Promise<{
    changedFiles: Array<{ path: string; data: string; sizeBytes: number }>;
    skippedFiles: Array<{ path: string; reason: string }>;
  }> {
    const changedFiles: Array<{ path: string; data: string; sizeBytes: number }> = [];
    const skippedFiles: Array<{ path: string; reason: string }> = [];

    const postSnapshot = await this.walkDir(filesDir);
    let totalBytes = 0;

    for (const entry of postSnapshot) {
      const pre = this.snapshotCache.get(entry.path);
      // New file or modified (different mtime or size)
      if (!pre || pre.mtimeMs !== entry.mtimeMs || pre.size !== entry.size) {
        if (entry.size > MAX_FILE_BYTES) {
          skippedFiles.push({ path: entry.path, reason: `File exceeds 10MB limit (${(entry.size / 1024 / 1024).toFixed(1)}MB)` });
          continue;
        }
        if (totalBytes + entry.size > MAX_TOTAL_BYTES) {
          skippedFiles.push({ path: entry.path, reason: "Total output exceeds 50MB limit" });
          continue;
        }

        const fullPath = path.join(filesDir, entry.path);
        const file = Bun.file(fullPath);
        const buffer = Buffer.from(await file.arrayBuffer());
        totalBytes += entry.size;
        changedFiles.push({ path: entry.path, data: buffer.toString("base64"), sizeBytes: entry.size });
      }
    }

    return { changedFiles, skippedFiles };
  }

  // Temporary storage for pre-execution snapshot
  private snapshotCache = new Map<string, { mtimeMs: number; size: number }>();

  async runScript(
    sandboxId: string,
    script: string,
    packages?: string[],
    timeout?: number,
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
    changedFiles?: Array<{ path: string; data: string; sizeBytes: number }>;
    skippedFiles?: Array<{ path: string; reason: string }>;
  }> {
    const state = this.sandboxes.get(sandboxId);
    if (!state) throw new Error(`Sandbox ${sandboxId} not found`);
    this.touch(sandboxId);

    const dir = this.sandboxDir(sandboxId);
    const filesDir = path.join(dir, "files");

    // Take pre-execution snapshot
    const preSnapshot = await this.walkDir(filesDir);
    this.snapshotCache.clear();
    for (const entry of preSnapshot) {
      this.snapshotCache.set(entry.path, { mtimeMs: entry.mtimeMs, size: entry.size });
    }

    // Write script to temp file
    const scriptId = crypto.randomUUID().slice(0, 8);
    const scriptPath = path.join(dir, "scripts", `${scriptId}.py`);
    await Bun.write(scriptPath, script);

    // Auto-detect imports and resolve packages
    const detected = detectImports(script);
    const resolved = resolvePackages(detected, packages);

    // Build command: uv run [--with pkg1 --with pkg2 ...] -- python script.py
    const cmd: string[] = ["uv", "run"];
    for (const pkg of resolved) {
      cmd.push("--with", pkg);
    }
    cmd.push("--", "python", scriptPath);

    const effectiveTimeout = timeout ?? DEFAULT_SCRIPT_TIMEOUT;
    const proc = Bun.spawn(cmd, {
      cwd: filesDir,
      stdout: "pipe",
      stderr: "pipe",
    });

    state.processes.add(proc);
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
      killTimer = setTimeout(() => {
        try { proc.kill(9); } catch {}
      }, SIGKILL_DELAY);
    }, effectiveTimeout);

    const [stdout, stderr] = await Promise.all([
      readCapped(proc.stdout, MAX_OUTPUT_BYTES),
      readCapped(proc.stderr, MAX_OUTPUT_BYTES),
    ]);
    await proc.exited;
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    state.processes.delete(proc);

    // Clean up script file
    fs.unlink(scriptPath).catch(() => {});

    const exitCode = timedOut ? -1 : (proc.exitCode ?? 1);

    // Collect changed files via snapshot diff
    const { changedFiles, skippedFiles } = await this.collectChangedFiles(filesDir);

    return {
      stdout,
      stderr,
      exitCode,
      ...(changedFiles.length > 0 ? { changedFiles } : {}),
      ...(skippedFiles.length > 0 ? { skippedFiles } : {}),
    };
  }

  async destroySandbox(sandboxId: string): Promise<void> {
    const state = this.sandboxes.get(sandboxId);
    if (!state) return;

    // Kill all running processes (SIGTERM, then SIGKILL after delay)
    for (const proc of state.processes) {
      try { proc.kill(); } catch {}
      setTimeout(() => {
        try { proc.kill(9); } catch {}
      }, SIGKILL_DELAY);
    }

    this.sandboxes.delete(sandboxId);

    // Remove sandbox directory
    const dir = this.sandboxDir(sandboxId);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  async destroyAll(): Promise<void> {
    const ids = [...this.sandboxes.keys()];
    await Promise.all(ids.map((id) => this.destroySandbox(id)));
  }

  stop(): void {
    clearInterval(this.reaper);
    this.destroyAll();
  }
}
