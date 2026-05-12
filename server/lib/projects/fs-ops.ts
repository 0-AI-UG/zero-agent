/**
 * Host-filesystem helpers used by routes/files.ts and friends.
 *
 * Centralizes path safety (workspace-relative paths must stay inside the
 * project directory) and the file primitives the routes used to delegate
 * to the runner backend.
 */
import { createReadStream } from "node:fs";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, normalize, resolve } from "node:path";
import { projectDirFor } from "@/lib/pi/run-turn.ts";
import { ValidationError } from "@/lib/utils/errors.ts";

// Realpath the project dir itself: on macOS the test/temp tree is reached via
// /var → /private/var, and any future move of PI_PROJECTS_ROOT under a
// symlinked mountpoint would otherwise make every legitimate path look like
// an escape.
async function realProjectDir(projectId: string): Promise<string> {
  const dir = resolve(projectDirFor(projectId));
  try {
    return await realpath(dir);
  } catch {
    return dir;
  }
}

// Walk up from `abs` to the deepest existing ancestor, realpath that, then
// re-join the remaining components. Lets us validate write targets whose leaf
// (or leaf's parents) haven't been created yet without giving symlinks a free
// pass on the path we will actually open.
async function deepestRealpath(abs: string): Promise<string> {
  try {
    return await realpath(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    const parent = dirname(abs);
    if (parent === abs) throw err;
    const realParent = await deepestRealpath(parent);
    return join(realParent, basename(abs));
  }
}

async function ensureUnderProject(projectId: string, relPath: string): Promise<string> {
  const projectDir = await realProjectDir(projectId);
  const cleaned = normalize(relPath).replace(/^\/+/, "");
  const abs = resolve(projectDir, cleaned);
  if (abs !== projectDir && !abs.startsWith(projectDir + "/")) {
    throw new ValidationError(`path escapes project dir: ${relPath}`);
  }
  const real = await deepestRealpath(abs);
  if (real !== projectDir && !real.startsWith(projectDir + "/")) {
    throw new ValidationError(`path escapes project dir via symlink: ${relPath}`);
  }
  return abs;
}

export async function writeProjectFile(
  projectId: string,
  relPath: string,
  buffer: Buffer | Uint8Array,
): Promise<void> {
  const abs = await ensureUnderProject(projectId, relPath);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer));
}

export async function readProjectFile(
  projectId: string,
  relPath: string,
): Promise<Buffer | null> {
  const abs = await ensureUnderProject(projectId, relPath);
  try {
    return await readFile(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function deleteProjectPath(
  projectId: string,
  relPath: string,
): Promise<void> {
  const abs = await ensureUnderProject(projectId, relPath);
  await rm(abs, { recursive: true, force: true });
}

export async function moveProjectPath(
  projectId: string,
  fromRelPath: string,
  toRelPath: string,
): Promise<void> {
  const from = await ensureUnderProject(projectId, fromRelPath);
  const to = await ensureUnderProject(projectId, toRelPath);
  await mkdir(dirname(to), { recursive: true });
  await rename(from, to);
}

export interface ProjectFileStream {
  stream: ReadableStream<Uint8Array>;
  size: number;
}

export async function streamProjectFile(
  projectId: string,
  relPath: string,
): Promise<ProjectFileStream | null> {
  const abs = await ensureUnderProject(projectId, relPath);
  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await stat(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  if (!st.isFile()) return null;
  const node = createReadStream(abs);
  // Web ReadableStream wrapping the Node stream.
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      node.on("data", (chunk) => {
        controller.enqueue(
          chunk instanceof Buffer ? new Uint8Array(chunk) : (chunk as Uint8Array),
        );
      });
      node.on("end", () => controller.close());
      node.on("error", (err) => controller.error(err));
    },
    cancel() {
      node.destroy();
    },
  });
  return { stream, size: st.size };
}

export function workspacePathFor(folderPath: string, filename: string): string {
  const trimmed = folderPath.replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmed ? `${trimmed}/${filename}` : filename;
}

export { join as joinPath };
