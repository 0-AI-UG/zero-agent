/**
 * Per-turn workspace snapshots backed by a hidden git branch inside the
 * session container. We keep a dedicated branch (`zero-agent/turns`) with
 * its own identity so the agent's main git workflow inside /workspace is
 * unaffected. Each snapshot is a commit on this branch; reverts checkout
 * paths from a specific commit back into the working tree.
 *
 * All git plumbing runs via `docker exec` — the branch name and identity
 * are established once per container (idempotent).
 */
import { spawn } from "node:child_process";
import { log } from "./logger.ts";

const snapLog = log.child({ module: "snapshots" });

export const SNAPSHOT_BRANCH = "zero-agent/turns";
const SNAPSHOT_USER_NAME = "zero-agent";
const SNAPSHOT_USER_EMAIL = "agent@zero-agent.local";
const WORKSPACE = "/workspace";

export interface SnapshotDiffEntry {
  path: string;
  status: "added" | "modified" | "deleted";
  oldSha?: string;
  newSha?: string;
}

/** Run a command in the container, buffering stdout/stderr. */
function dockerExec(
  containerName: string,
  cmd: string[],
  opts?: { workingDir?: string },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const args = ["exec"];
    if (opts?.workingDir) args.push("-w", opts.workingDir);
    args.push(containerName, ...cmd);
    const proc = spawn("docker", args);
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

/** Run a git command inside /workspace. */
async function git(
  containerName: string,
  gitArgs: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return dockerExec(containerName, ["git", ...gitArgs], { workingDir: WORKSPACE });
}

/**
 * Ensure /workspace is a git repo with the hidden snapshot branch checked
 * out. Safe to call repeatedly — no-op if the branch already exists.
 */
export async function ensureSnapshotRepo(containerName: string): Promise<void> {
  const hasGit = await dockerExec(containerName, ["test", "-d", "/workspace/.git"]);
  if (hasGit.exitCode !== 0) {
    snapLog.info("initializing snapshot repo", { containerName });
    const init = await git(containerName, ["init", "-q", "-b", SNAPSHOT_BRANCH]);
    if (init.exitCode !== 0) {
      // Fallback for older git without -b on init
      const plainInit = await git(containerName, ["init", "-q"]);
      if (plainInit.exitCode !== 0) {
        throw new Error(`git init failed: ${plainInit.stderr || init.stderr}`);
      }
      const co = await git(containerName, ["checkout", "-q", "-b", SNAPSHOT_BRANCH]);
      if (co.exitCode !== 0) {
        throw new Error(`failed to create snapshot branch: ${co.stderr}`);
      }
    }
    await git(containerName, ["config", "user.name", SNAPSHOT_USER_NAME]);
    await git(containerName, ["config", "user.email", SNAPSHOT_USER_EMAIL]);
    const initial = await git(containerName, [
      "commit", "-q", "--allow-empty", "-m", "init",
    ]);
    if (initial.exitCode !== 0) {
      throw new Error(`initial snapshot commit failed: ${initial.stderr}`);
    }
    return;
  }

  await git(containerName, ["config", "user.name", SNAPSHOT_USER_NAME]);
  await git(containerName, ["config", "user.email", SNAPSHOT_USER_EMAIL]);

  const branchCheck = await git(containerName, [
    "rev-parse", "--verify", "--quiet", `refs/heads/${SNAPSHOT_BRANCH}`,
  ]);
  if (branchCheck.exitCode !== 0) {
    snapLog.info("creating snapshot branch on existing repo", { containerName });
    const co = await git(containerName, ["checkout", "-q", "-b", SNAPSHOT_BRANCH]);
    if (co.exitCode !== 0) {
      throw new Error(`failed to create snapshot branch: ${co.stderr}`);
    }
    await git(containerName, [
      "commit", "-q", "--allow-empty", "-m", "init",
    ]);
  }
}

/**
 * Stage all changes in /workspace and commit on the snapshot branch.
 * Returns the full 40-char commit sha.
 */
export async function createSnapshot(
  containerName: string,
  message: string,
): Promise<string> {
  await ensureSnapshotRepo(containerName);

  // Make sure the snapshot branch is checked out before staging — we must
  // never commit onto the agent's own HEAD.
  const co = await git(containerName, ["checkout", "-q", SNAPSHOT_BRANCH]);
  if (co.exitCode !== 0) {
    throw new Error(`failed to checkout snapshot branch: ${co.stderr}`);
  }

  const add = await git(containerName, ["add", "-A"]);
  if (add.exitCode !== 0) {
    throw new Error(`git add failed: ${add.stderr}`);
  }

  const commit = await git(containerName, [
    "commit", "-q", "--allow-empty", "-m", message,
  ]);
  if (commit.exitCode !== 0) {
    throw new Error(`git commit failed: ${commit.stderr}`);
  }

  const revParse = await git(containerName, ["rev-parse", "HEAD"]);
  if (revParse.exitCode !== 0) {
    throw new Error(`git rev-parse HEAD failed: ${revParse.stderr}`);
  }
  const sha = revParse.stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`unexpected rev-parse output: ${sha}`);
  }
  return sha;
}

/**
 * Compute the diff between two commits. Returns workspace-relative paths
 * with add/modify/delete statuses and blob shas.
 */
export async function diffSnapshots(
  containerName: string,
  fromSha: string,
  toSha: string,
): Promise<SnapshotDiffEntry[]> {
  await ensureSnapshotRepo(containerName);
  // --raw gives us `:<old-mode> <new-mode> <old-sha> <new-sha> <status>\0<path>\0`
  const res = await git(containerName, [
    "diff", "--raw", "-z", "--no-renames", fromSha, toSha,
  ]);
  if (res.exitCode !== 0) {
    throw new Error(`git diff failed: ${res.stderr}`);
  }

  const out: SnapshotDiffEntry[] = [];
  const buf = res.stdout;
  let i = 0;
  while (i < buf.length) {
    while (i < buf.length && buf[i] === "\0") i++;
    if (i >= buf.length) break;

    const metaEnd = buf.indexOf("\0", i);
    if (metaEnd === -1) break;
    const meta = buf.slice(i, metaEnd);
    i = metaEnd + 1;

    const pathEnd = buf.indexOf("\0", i);
    const path = pathEnd === -1 ? buf.slice(i) : buf.slice(i, pathEnd);
    i = pathEnd === -1 ? buf.length : pathEnd + 1;

    // meta: ":100644 100644 <oldsha> <newsha> M"
    const parts = meta.replace(/^:/, "").split(" ");
    if (parts.length < 5) continue;
    const oldSha = parts[2]!;
    const newSha = parts[3]!;
    const statusChar = parts[4]![0];

    if (statusChar === "A") {
      out.push({ path, status: "added", newSha });
    } else if (statusChar === "D") {
      out.push({ path, status: "deleted", oldSha });
    } else {
      out.push({ path, status: "modified", oldSha, newSha });
    }
  }
  return out;
}

/**
 * Stream the contents of <path> at <sha> as a raw byte stream.
 * Uses `git cat-file -p <sha>:<path>` piped through stdout.
 */
export function streamFileAtSnapshot(
  containerName: string,
  sha: string,
  relPath: string,
): ReadableStream<Uint8Array> {
  const cleanPath = relPath.replace(/^\/+/, "");
  const proc = spawn("docker", [
    "exec", "-w", WORKSPACE, containerName,
    "git", "cat-file", "-p", `${sha}:${cleanPath}`,
  ]);

  return new ReadableStream<Uint8Array>({
    start(controller) {
      proc.stdout.on("data", (chunk: Buffer) => {
        try { controller.enqueue(new Uint8Array(chunk)); } catch {}
      });
      proc.stdout.on("end", () => {
        try { controller.close(); } catch {}
      });
      proc.on("error", (err) => {
        try { controller.error(err); } catch {}
      });
      proc.stderr.on("data", (chunk: Buffer) => {
        snapLog.debug("git cat-file stderr", { msg: chunk.toString().slice(0, 200) });
      });
    },
    cancel() {
      try { proc.kill(); } catch {}
    },
  });
}

/**
 * Revert the given paths in /workspace to their state at <sha>.
 * Uses `git checkout <sha> -- <path>...`. Returns the list of paths that
 * were successfully restored.
 */
export async function revertPaths(
  containerName: string,
  sha: string,
  paths: string[],
): Promise<string[]> {
  await ensureSnapshotRepo(containerName);
  if (paths.length === 0) return [];

  const cleaned = paths.map((p) => p.replace(/^\/+/, ""));
  const reverted: string[] = [];
  for (const p of cleaned) {
    const res = await git(containerName, ["checkout", sha, "--", p]);
    if (res.exitCode === 0) {
      reverted.push(p);
    } else {
      snapLog.warn("failed to revert path", {
        containerName, sha, path: p, stderr: res.stderr.slice(0, 200),
      });
    }
  }
  return reverted;
}
