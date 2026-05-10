/**
 * Host-filesystem helpers used by routes/files.ts and friends.
 *
 * Centralizes path safety (workspace-relative paths must stay inside the
 * project directory) and the file primitives the routes used to delegate
 * to the runner backend.
 */
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, normalize, resolve } from "node:path";
import { projectDirFor } from "@/lib/pi/run-turn.ts";

function ensureUnderProject(projectId: string, relPath: string): string {
  const projectDir = resolve(projectDirFor(projectId));
  const cleaned = normalize(relPath).replace(/^\/+/, "");
  const abs = resolve(projectDir, cleaned);
  if (abs !== projectDir && !abs.startsWith(projectDir + "/")) {
    throw new Error(`path escapes project dir: ${relPath}`);
  }
  return abs;
}

export function projectPath(projectId: string, relPath: string): string {
  return ensureUnderProject(projectId, relPath);
}

export async function writeProjectFile(
  projectId: string,
  relPath: string,
  buffer: Buffer | Uint8Array,
): Promise<void> {
  const abs = ensureUnderProject(projectId, relPath);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer));
}

export async function readProjectFile(
  projectId: string,
  relPath: string,
): Promise<Buffer | null> {
  const abs = ensureUnderProject(projectId, relPath);
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
  const abs = ensureUnderProject(projectId, relPath);
  await rm(abs, { recursive: true, force: true });
}

export async function moveProjectPath(
  projectId: string,
  fromRelPath: string,
  toRelPath: string,
): Promise<void> {
  const from = ensureUnderProject(projectId, fromRelPath);
  const to = ensureUnderProject(projectId, toRelPath);
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
  const abs = ensureUnderProject(projectId, relPath);
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
