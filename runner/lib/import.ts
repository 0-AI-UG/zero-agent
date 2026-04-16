/**
 * Import primitive — fetch a presigned S3 URL and stream its body into a
 * file inside a managed container, using an atomic rename on the container
 * filesystem. If the destination already matches `expectedHash`, we skip
 * the transfer entirely.
 *
 * All container I/O goes through `docker exec` (spawned) so we can pipe
 * the fetch body into the container over stdin without buffering the
 * whole object in the runner.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { log } from "./logger.ts";

const impLog = log.child({ module: "import" });

const WORKSPACE = "/workspace";
const TMP_DIR = "/tmp/imports";

export interface ImportRequest {
  path: string;         // /workspace-relative, no leading slash
  url: string;          // presigned S3 GET URL
  expectedHash: string; // sha256 hex of the object
}

export interface ImportResult {
  status: "written" | "skipped-same-hash";
  bytes: number;
}

/** Reject any path that would escape /workspace. */
function sanitizeRelPath(p: string): string {
  if (!p || typeof p !== "string") throw new Error("path required");
  if (p.startsWith("/")) throw new Error("path must be workspace-relative");
  const parts = p.split("/");
  for (const seg of parts) {
    if (seg === "..") throw new Error("path must not contain '..'");
  }
  return p;
}

/** Buffered docker exec — same shape used in snapshots.ts. */
function dockerExec(
  containerName: string,
  cmd: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const proc = spawn("docker", ["exec", containerName, ...cmd]);
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    proc.stdout.on("data", (d: Buffer) => outChunks.push(d));
    proc.stderr.on("data", (d: Buffer) => errChunks.push(d));
    proc.on("close", (code) => {
      resolve({
        stdout: Buffer.concat(outChunks).toString("utf-8"),
        stderr: Buffer.concat(errChunks).toString("utf-8"),
        exitCode: code ?? -1,
      });
    });
    proc.on("error", (err) => {
      resolve({ stdout: "", stderr: String(err), exitCode: -1 });
    });
  });
}

/** Compute sha256 of an existing file in the container, or null if missing. */
async function containerFileSha256(
  containerName: string,
  absPath: string,
): Promise<string | null> {
  const test = await dockerExec(containerName, ["test", "-f", absPath]);
  if (test.exitCode !== 0) return null;
  const res = await dockerExec(containerName, ["sha256sum", absPath]);
  if (res.exitCode !== 0) return null;
  const hex = res.stdout.trim().split(/\s+/)[0];
  if (!hex || !/^[0-9a-f]{64}$/.test(hex)) return null;
  return hex;
}

/**
 * Stream the fetch body into `docker exec -i sh -c 'cat > <tmpPath>'`
 * inside the container. Returns the number of bytes written.
 */
async function streamUrlToContainerTmp(
  containerName: string,
  url: string,
  tmpPath: string,
): Promise<number> {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`fetch failed: ${res.status} ${res.statusText}`);
  }

  // Use sh -c 'cat > path' so we can redirect stdin into the file without
  // a host bind-mount. Quote the path with single quotes (path is our own
  // uuid-generated, so no injection risk).
  const proc = spawn("docker", [
    "exec", "-i", containerName,
    "sh", "-c", `cat > '${tmpPath}'`,
  ]);

  let bytes = 0;
  let stderr = "";
  proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

  const reader = res.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      const ok = proc.stdin.write(value);
      if (!ok) {
        await new Promise<void>((r) => proc.stdin.once("drain", () => r()));
      }
    }
  } finally {
    try { reader.releaseLock(); } catch {}
    proc.stdin.end();
  }

  const exitCode: number = await new Promise((resolve) => {
    proc.on("close", (code) => resolve(code ?? -1));
    proc.on("error", () => resolve(-1));
  });
  if (exitCode !== 0) {
    throw new Error(`docker exec (write tmp) failed: ${stderr || exitCode}`);
  }
  return bytes;
}

export async function importIntoContainer(
  containerName: string,
  req: ImportRequest,
): Promise<ImportResult> {
  const relPath = sanitizeRelPath(req.path);
  const absTarget = `${WORKSPACE}/${relPath}`;

  if (!/^[0-9a-f]{64}$/.test(req.expectedHash)) {
    throw new Error("expectedHash must be 64-char sha256 hex");
  }

  // Short-circuit when the destination already matches the expected hash.
  const existing = await containerFileSha256(containerName, absTarget);
  if (existing === req.expectedHash) {
    impLog.debug("import skipped (same hash)", { containerName, relPath });
    return { status: "skipped-same-hash", bytes: 0 };
  }

  // Ensure tmp dir and parent dir exist. Both live on the same overlay/
  // volume as /workspace is bind-mounted from the container's writable
  // layer (or a named volume) — both /tmp/imports and /workspace are under
  // the container's root, so mv across them is not necessarily atomic
  // (different filesystems can't rename). To guarantee atomic rename, use
  // a temp path inside the workspace parent dir itself.
  const parentDir = absTarget.includes("/")
    ? absTarget.slice(0, absTarget.lastIndexOf("/"))
    : WORKSPACE;

  const mkParent = await dockerExec(containerName, ["mkdir", "-p", parentDir]);
  if (mkParent.exitCode !== 0) {
    throw new Error(`mkdir parent failed: ${mkParent.stderr}`);
  }
  const mkTmp = await dockerExec(containerName, ["mkdir", "-p", TMP_DIR]);
  if (mkTmp.exitCode !== 0) {
    throw new Error(`mkdir tmp failed: ${mkTmp.stderr}`);
  }

  // Sibling temp path — guaranteed same filesystem as the target, so
  // `mv` is an atomic rename(2).
  const sibling = `${parentDir}/.import-${randomUUID()}.tmp`;

  try {
    const bytes = await streamUrlToContainerTmp(containerName, req.url, sibling);
    const mv = await dockerExec(containerName, ["mv", sibling, absTarget]);
    if (mv.exitCode !== 0) {
      throw new Error(`mv failed: ${mv.stderr}`);
    }
    impLog.info("import written", { containerName, relPath, bytes });
    return { status: "written", bytes };
  } catch (err) {
    // Best-effort cleanup of the sibling tmp file on failure.
    await dockerExec(containerName, ["rm", "-f", sibling]).catch(() => {});
    throw err;
  }
}
