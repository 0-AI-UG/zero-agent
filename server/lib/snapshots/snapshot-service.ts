/**
 * Snapshot service — host-filesystem git snapshots.
 *
 * Every Pi turn produces two commits in a hidden git directory under the
 * project (`<projectDir>/.git-snapshots`). The work tree is the project
 * directory itself, but the gitdir is separate so the snapshot history
 * cannot interfere with any user-facing `.git` inside the project.
 *
 * Failures here never abort the turn — snapshots are best-effort. The
 * `turn_snapshots` table records the commit sha + turn metadata so the UI
 * can diff against the parent and revert per-file.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  insertTurnSnapshot,
  latestTurnSnapshotForChat,
} from "@/db/queries/turn-snapshots.ts";
import { broadcastToChat } from "@/lib/http/ws.ts";
import { projectDirFor } from "@/lib/pi/run-turn.ts";
import { log } from "@/lib/utils/logger.ts";
import type { TurnDiffEntry } from "./types.ts";

const snapLog = log.child({ module: "snapshot-service" });
const execFileP = promisify(execFile);

const EXCLUDE_PATTERNS = [
  ".pi-sessions/",
  ".git-snapshots/",
  ".git/",
  "node_modules/",
  ".venv/",
  "__pycache__/",
];

export interface SnapshotContext {
  projectId: string;
  chatId: string;
  runId: string;
}

export interface SnapshotResult {
  snapshotId: string;
  commitSha: string;
}

function gitDirFor(projectId: string): string {
  return join(projectDirFor(projectId), ".git-snapshots");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function git(
  projectId: string,
  args: string[],
  opts: { input?: string } = {},
): Promise<{ stdout: string; stderr: string }> {
  const projectDir = projectDirFor(projectId);
  const gitDir = gitDirFor(projectId);
  const fullArgs = [
    "--git-dir",
    gitDir,
    "--work-tree",
    projectDir,
    ...args,
  ];
  const result = await execFileP("git", fullArgs, {
    cwd: projectDir,
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "zero",
      GIT_AUTHOR_EMAIL: "zero@local",
      GIT_COMMITTER_NAME: "zero",
      GIT_COMMITTER_EMAIL: "zero@local",
    },
    ...(opts.input ? { input: opts.input } : {}),
  });
  return result;
}

async function gitBuffer(
  projectId: string,
  args: string[],
): Promise<Buffer> {
  const projectDir = projectDirFor(projectId);
  const gitDir = gitDirFor(projectId);
  const fullArgs = [
    "--git-dir",
    gitDir,
    "--work-tree",
    projectDir,
    ...args,
  ];
  return await new Promise<Buffer>((resolve, reject) => {
    const child = execFile(
      "git",
      fullArgs,
      {
        cwd: projectDir,
        maxBuffer: 64 * 1024 * 1024,
        encoding: "buffer",
      },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout as Buffer);
      },
    );
    if (!child) {
      reject(new Error("execFile returned no child"));
    }
  });
}

async function ensureSnapshotRepo(projectId: string): Promise<void> {
  const projectDir = projectDirFor(projectId);
  const gitDir = gitDirFor(projectId);
  await mkdir(projectDir, { recursive: true });
  // Check for an actual git repo (HEAD file), not just dir existence — a
  // partially-initialized directory (e.g. only `info/exclude` written) would
  // otherwise fool us into skipping `git init`.
  if (!(await pathExists(join(gitDir, "HEAD")))) {
    await mkdir(gitDir, { recursive: true });
    await execFileP("git", ["--git-dir", gitDir, "init", "--quiet"], {
      cwd: projectDir,
    });
    // Configure user (per-repo so we don't depend on global config) and
    // disable any pre-existing global hooks that would slow us down.
    await git(projectId, ["config", "user.name", "zero"]);
    await git(projectId, ["config", "user.email", "zero@local"]);
    await git(projectId, ["config", "core.autocrlf", "false"]);
    await git(projectId, ["config", "core.hooksPath", "/dev/null"]);
  }
  // Always write the exclude file in case patterns evolve.
  const excludePath = join(gitDir, "info", "exclude");
  await mkdir(join(gitDir, "info"), { recursive: true });
  await writeFile(excludePath, EXCLUDE_PATTERNS.join("\n") + "\n");
}

async function commitWorkingTree(
  projectId: string,
  message: string,
): Promise<string> {
  await ensureSnapshotRepo(projectId);
  // Stage everything (respecting the per-repo exclude file). `--all` picks up
  // deletes too, so the next commit reflects the working tree exactly.
  await git(projectId, ["add", "--all", "."]);
  // Commit with --allow-empty so the diff chain remains contiguous even if
  // a turn produced no file changes.
  await git(projectId, [
    "commit",
    "--allow-empty",
    "--no-verify",
    "--no-gpg-sign",
    "-m",
    message,
  ]);
  const { stdout } = await git(projectId, ["rev-parse", "HEAD"]);
  return stdout.trim();
}

export async function snapshotBeforeTurn(
  ctx: SnapshotContext,
): Promise<SnapshotResult | null> {
  const { projectId, chatId, runId } = ctx;
  try {
    const commitSha = await commitWorkingTree(projectId, `pre-turn ${runId}`);
    const latest = latestTurnSnapshotForChat(chatId);
    const turnIndex = latest ? latest.turn_index + 1 : 0;
    const parentSnapshotId = latest ? latest.id : null;
    const row = insertTurnSnapshot({
      projectId,
      chatId,
      runId,
      turnIndex,
      parentSnapshotId,
      commitSha,
    });
    return { snapshotId: row.id, commitSha };
  } catch (err) {
    snapLog.warn("snapshotBeforeTurn failed", {
      projectId,
      chatId,
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function snapshotAfterTurn(
  ctx: SnapshotContext & { preSnapshotId: string },
): Promise<SnapshotResult | null> {
  const { projectId, chatId, runId, preSnapshotId } = ctx;
  try {
    const commitSha = await commitWorkingTree(projectId, `post-turn ${runId}`);
    const latest = latestTurnSnapshotForChat(chatId);
    const turnIndex = latest ? latest.turn_index + 1 : 0;
    const row = insertTurnSnapshot({
      projectId,
      chatId,
      runId,
      turnIndex,
      parentSnapshotId: preSnapshotId,
      commitSha,
    });
    broadcastToChat(chatId, {
      type: "turn.diff.ready",
      chatId,
      runId,
      preSnapshotId,
      postSnapshotId: row.id,
    });
    return { snapshotId: row.id, commitSha };
  } catch (err) {
    snapLog.warn("snapshotAfterTurn failed", {
      projectId,
      chatId,
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Diff entries between two snapshot commits (parent ← against, child ← sha).
 * Returns added/modified/deleted paths with the file blob shas so the UI can
 * lazily fetch each side via `readSnapshotFile`.
 */
export async function getSnapshotDiff(
  projectId: string,
  sha: string,
  against: string,
): Promise<TurnDiffEntry[]> {
  const { stdout } = await git(projectId, [
    "diff-tree",
    "-r",
    "--no-renames",
    "--no-commit-id",
    "-z",
    against,
    sha,
  ]);
  // `diff-tree -z` output format: each entry is
  //   :<srcMode> <dstMode> <srcSha> <dstSha> <status>\0<path>\0
  // Statuses we care about: A (added), D (deleted), M (modified).
  const entries: TurnDiffEntry[] = [];
  const fields = stdout.split("\0").filter((s) => s.length > 0);
  for (let i = 0; i < fields.length; ) {
    const meta = fields[i++]!;
    if (!meta.startsWith(":")) continue;
    const parts = meta.slice(1).split(" ");
    if (parts.length < 5) continue;
    const oldSha = parts[2]!;
    const newSha = parts[3]!;
    const statusChar = parts[4]!;
    const path = fields[i++]!;
    if (statusChar.startsWith("R") || statusChar.startsWith("C")) {
      // shouldn't happen with --no-renames, but be defensive.
      i++;
    }
    let status: TurnDiffEntry["status"];
    if (statusChar === "A") status = "added";
    else if (statusChar === "D") status = "deleted";
    else if (statusChar === "M") status = "modified";
    else continue;
    entries.push({
      path,
      status,
      oldSha: status === "added" ? undefined : oldSha,
      newSha: status === "deleted" ? undefined : newSha,
    });
  }
  return entries;
}

export async function readSnapshotFile(
  projectId: string,
  sha: string,
  path: string,
): Promise<Buffer> {
  return await gitBuffer(projectId, ["show", `${sha}:${path}`]);
}

/**
 * Restore the listed paths to their state at `sha`. Accepts paths that may
 * have been deleted in `sha` — those are removed from the working tree.
 */
export async function revertSnapshotPaths(
  projectId: string,
  sha: string,
  paths: string[],
): Promise<{ reverted: string[]; failed: { path: string; error: string }[] }> {
  const reverted: string[] = [];
  const failed: { path: string; error: string }[] = [];
  const projectDir = projectDirFor(projectId);

  for (const path of paths) {
    let existsInSha = true;
    try {
      await git(projectId, ["cat-file", "-e", `${sha}:${path}`]);
    } catch {
      existsInSha = false;
    }

    try {
      if (existsInSha) {
        await git(projectId, ["checkout", sha, "--", path]);
      } else {
        const absPath = join(projectDir, path);
        try {
          const { unlink } = await import("node:fs/promises");
          await unlink(absPath);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== "ENOENT") throw err;
        }
        // Also drop the path from the snapshot index so a future snapshot
        // doesn't show it as a phantom modification.
        try {
          await git(projectId, ["rm", "--cached", "--ignore-unmatch", "--", path]);
        } catch {
          // best-effort
        }
      }
      reverted.push(path);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      snapLog.warn("revertSnapshotPaths: failed to revert path", {
        projectId,
        sha,
        path,
        error: message,
      });
      failed.push({ path, error: message });
    }
  }
  return { reverted, failed };
}

/** Convenience for `routes/files.ts`-style callers that want a hash. */
export async function hashFile(absPath: string): Promise<string> {
  const buf = await readFile(absPath);
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(buf).digest("hex");
}
