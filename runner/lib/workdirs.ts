/**
 * Per-call overlayfs workdirs.
 *
 * Phase 5 isolation primitive: a caller allocates a workdir which mounts
 * an overlayfs inside the container with lower=/workspace,
 * upper=/tmp/calls/<id>/upper, work=/tmp/calls/<id>/work, merged at
 * /workspace-<id>. Ops running under that workdir see /workspace-<id>.
 * On flush, the upper layer is copied into /workspace (including handling
 * overlayfs whiteout markers to remove deleted files). On drop, the
 * overlay is unmounted and temp dirs removed.
 *
 * All state is docker exec driven, following the same pattern as
 * runner/lib/snapshots.ts.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { log } from "./logger.ts";

const wdLog = log.child({ module: "workdirs" });

export interface WorkdirState {
  id: string;
  containerName: string;
  lower: string;
  upper: string;
  workDir: string;
  merged: string;
  allocatedAt: number;
}

/** containerName -> (workdirId -> state) */
const workdirs = new Map<string, Map<string, WorkdirState>>();

function getContainerMap(containerName: string): Map<string, WorkdirState> {
  let m = workdirs.get(containerName);
  if (!m) {
    m = new Map();
    workdirs.set(containerName, m);
  }
  return m;
}

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

/**
 * Allocate a fresh overlayfs workdir inside <containerName>.
 * Creates upper/work/merged paths and mounts the overlay.
 */
export async function allocateWorkdir(containerName: string): Promise<WorkdirState> {
  const id = randomUUID();
  const upper = `/tmp/calls/${id}/upper`;
  const workDir = `/tmp/calls/${id}/work`;
  const merged = `/workspace-${id}`;
  const lower = "/workspace";

  const mk = await dockerExec(containerName, ["mkdir", "-p", upper, workDir, merged]);
  if (mk.exitCode !== 0) {
    throw new Error(`mkdir for workdir ${id} failed: ${mk.stderr}`);
  }

  const mount = await dockerExec(containerName, [
    "mount",
    "-t", "overlay", "overlay",
    "-o", `lowerdir=${lower},upperdir=${upper},workdir=${workDir}`,
    merged,
  ]);
  if (mount.exitCode !== 0) {
    // Best-effort cleanup
    await dockerExec(containerName, ["rm", "-rf", `/tmp/calls/${id}`, merged]).catch(() => {});
    throw new Error(`overlay mount for workdir ${id} failed: ${mount.stderr}`);
  }

  const state: WorkdirState = {
    id,
    containerName,
    lower,
    upper,
    workDir,
    merged,
    allocatedAt: Date.now(),
  };
  getContainerMap(containerName).set(id, state);
  wdLog.info("allocated workdir", { containerName, id });
  return state;
}

/**
 * Flush the upper layer of workdir <id> back into /workspace.
 *
 * Strategy:
 *   1. Walk the upper dir for overlayfs whiteout markers. Whiteouts are
 *      character devices with major=0, minor=0 — their existence in upper
 *      means "delete this path from lower". For each whiteout, remove the
 *      corresponding entry in /workspace.
 *   2. Copy everything remaining in upper (regular files, dirs, opaque
 *      dir markers) into /workspace with `cp -a`.
 *
 * Returns an approximate change count = whiteouts removed + top-level
 * upper entries copied. This is a simplified counter; a precise per-file
 * count would require walking upper ourselves.
 *
 * NOTE: overlay "opaque directory" xattrs (trusted.overlay.opaque="y")
 * which indicate "this dir replaced lower, do not merge" are NOT handled
 * here. For Phase 5 initial version we assume callers do not perform
 * whole-directory replacements; if they do, stale lower files under that
 * dir may remain. Document as a known limitation.
 */
export async function flushWorkdir(
  containerName: string,
  id: string,
): Promise<{ changes: number }> {
  const state = getContainerMap(containerName).get(id);
  if (!state) {
    throw new Error(`workdir ${id} not found for container ${containerName}`);
  }

  let changes = 0;

  // 1. Find whiteouts: character devices under upper. Use `find` with
  //    -printf so we get stat info; char-dev 0/0 == whiteout.
  //    Paths from find are relative when we `cd` into upper via -w.
  const findRes = await dockerExec(
    containerName,
    [
      "sh", "-c",
      // %y=type, %T=device major:minor on some systems; use stat per-match
      // to be portable. List all char devices under upper.
      `find . -type c -printf '%p\\n' 2>/dev/null || true`,
    ],
    { workingDir: state.upper },
  );

  const charPaths = findRes.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  for (const rel of charPaths) {
    // rel looks like "./foo/bar"
    const cleanRel = rel.replace(/^\.\//, "");
    // stat the device numbers
    const stat = await dockerExec(containerName, [
      "stat", "-c", "%t:%T", `${state.upper}/${cleanRel}`,
    ]);
    if (stat.exitCode !== 0) continue;
    // %t and %T are hex major/minor. Whiteout == 0:0.
    const trimmed = stat.stdout.trim();
    if (trimmed === "0:0") {
      // Delete from /workspace
      const del = await dockerExec(containerName, [
        "rm", "-rf", `${state.lower}/${cleanRel}`,
      ]);
      if (del.exitCode === 0) changes++;
      // Also drop the whiteout from upper so the subsequent cp -a doesn't
      // try to copy a char device into /workspace (cp -a preserves device
      // files and would recreate a 0/0 char dev in lower).
      await dockerExec(containerName, ["rm", "-f", `${state.upper}/${cleanRel}`]).catch(() => {});
    }
  }

  // 2. Copy remaining upper contents into /workspace. Count top-level
  //    entries as a proxy for "changes".
  const cpRes = await dockerExec(containerName, [
    "sh", "-c",
    `cp -a ${state.upper}/. ${state.lower}/ 2>/dev/null && ls -A ${state.upper} | wc -l`,
  ]);
  if (cpRes.exitCode === 0) {
    const n = parseInt(cpRes.stdout.trim(), 10);
    if (Number.isFinite(n)) changes += n;
  } else {
    wdLog.warn("cp from upper to lower failed", {
      containerName, id, stderr: cpRes.stderr.slice(0, 200),
    });
  }

  wdLog.info("flushed workdir", { containerName, id, changes });
  return { changes };
}

/**
 * Unmount the overlay and remove temp dirs for workdir <id>.
 * Always removes the map entry even if teardown partially fails.
 */
export async function dropWorkdir(containerName: string, id: string): Promise<void> {
  const m = getContainerMap(containerName);
  const state = m.get(id);
  if (!state) {
    wdLog.debug("drop: workdir not found (already dropped?)", { containerName, id });
    return;
  }

  const umount = await dockerExec(containerName, ["umount", state.merged]);
  if (umount.exitCode !== 0) {
    wdLog.warn("umount failed, continuing cleanup", {
      containerName, id, stderr: umount.stderr.slice(0, 200),
    });
  }

  const rm = await dockerExec(containerName, [
    "rm", "-rf", `/tmp/calls/${id}`, state.merged,
  ]);
  if (rm.exitCode !== 0) {
    wdLog.warn("rm -rf of workdir paths failed", {
      containerName, id, stderr: rm.stderr.slice(0, 200),
    });
  }

  m.delete(id);
  wdLog.info("dropped workdir", { containerName, id });
}

/**
 * Pure path resolver: returns an absolute path inside the container.
 * If workdirId is undefined → /workspace/<rel>.
 * Otherwise → /workspace-<id>/<rel>.
 *
 * Rejects relPath containing ".." segments to prevent escape.
 */
export function resolveWorkdirPath(
  _containerName: string,
  workdirId: string | undefined,
  relPath: string,
): string {
  const clean = relPath.replace(/^\/+/, "");
  const segments = clean.split("/");
  if (segments.some((s) => s === "..")) {
    throw new Error(`relPath must not contain '..': ${relPath}`);
  }
  const base = workdirId ? `/workspace-${workdirId}` : "/workspace";
  return clean ? `${base}/${clean}` : base;
}

/** List active workdirs for a container. */
export function listWorkdirs(containerName: string): WorkdirState[] {
  const m = workdirs.get(containerName);
  if (!m) return [];
  return [...m.values()];
}

/**
 * Cleanup hook: drop all workdirs registered for <containerName>.
 * Intended to be invoked from the container-destroy path. Safe to call
 * even if the container has already been removed — docker exec will
 * simply fail and we log + forget.
 */
export async function dropAllWorkdirsForContainer(containerName: string): Promise<void> {
  const m = workdirs.get(containerName);
  if (!m || m.size === 0) {
    workdirs.delete(containerName);
    return;
  }
  const ids = [...m.keys()];
  wdLog.info("dropping all workdirs for container", { containerName, count: ids.length });
  await Promise.allSettled(ids.map((id) => dropWorkdir(containerName, id)));
  workdirs.delete(containerName);
}
