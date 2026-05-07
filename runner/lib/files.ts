/**
 * In-container filesystem operations — all file I/O goes through Docker exec
 * or the Docker archive API. No host filesystem access.
 */
import { docker } from "./docker-client.ts";

const MAX_FILE_BYTES = 10 * 1024 * 1024;   // 10 MB per file
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;   // 50 MB total

// Always-exclude dirs for find commands — prevent noise and traversal into VCS/tmp.
const FIND_EXCLUDES = [".git", ".tmp"];

function buildFindPruneArgs(dirs: readonly string[]): string {
  if (dirs.length === 0) return "-false";
  return dirs.map(d => `-name '${d}' -prune`).join(" -o ");
}

export async function listFiles(
  containerName: string,
  dir = "/workspace",
): Promise<Set<string>> {
  const pruneArgs = buildFindPruneArgs(FIND_EXCLUDES);
  const result = await docker.exec(containerName, [
    "bash", "-c",
    `find ${dir} \\( ${pruneArgs} \\) -o -type f -print`,
  ], { workingDir: "/" });
  const files = new Set<string>();
  const prefix = dir.endsWith("/") ? dir : dir + "/";
  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && trimmed.startsWith(prefix)) {
      files.add(trimmed.slice(prefix.length));
    }
  }
  return files;
}

/**
 * Compute a sha256 manifest of every regular file under `dir` in the container.
 * Returns `{ relativePath: hex-hash }` keyed by path relative to `dir`.
 * Used by the server's workspace reconcile loop to diff DB state vs container state.
 */
export async function manifest(
  containerName: string,
  dir = "/workspace",
): Promise<Record<string, string>> {
  const pruneArgs = buildFindPruneArgs(FIND_EXCLUDES);
  // sha256sum prints "<hex>  <path>" per line. Use -print0/xargs-style safe form via -exec.
  const result = await docker.exec(containerName, [
    "bash", "-c",
    `find ${dir} \\( ${pruneArgs} \\) -o -type f -exec sha256sum {} +`,
  ], { workingDir: "/", timeout: 120_000 });

  const out: Record<string, string> = {};
  const prefix = dir.endsWith("/") ? dir : dir + "/";
  for (const line of result.stdout.split("\n")) {
    if (!line) continue;
    // sha256sum format: "<64 hex>  <path>"
    const sep = line.indexOf("  ");
    if (sep !== 64) continue;
    const hash = line.slice(0, 64);
    const fullPath = line.slice(sep + 2);
    if (fullPath.startsWith(prefix)) {
      out[fullPath.slice(prefix.length)] = hash;
    }
  }
  return out;
}


// -- Read files from container --

export interface ReadFile {
  path: string;
  data: string;        // base64
  sizeBytes: number;
}

export async function readFiles(containerName: string, relativePaths: string[], baseDir = "/workspace"): Promise<ReadFile[]> {
  if (relativePaths.length === 0) return [];

  const results: ReadFile[] = [];
  let totalBytes = 0;

  const escaped = relativePaths.map(p => `'${baseDir}/${p}'`).join(" ");
  const prefix = baseDir.endsWith("/") ? baseDir : baseDir + "/";
  const result = await docker.exec(containerName, [
    "bash", "-c",
    `for f in ${escaped}; do
      if [ -f "$f" ]; then
        sz=$(stat -c%s "$f" 2>/dev/null || echo 0)
        rel="\${f#${prefix}}"
        echo "::FILE::$rel::$sz"
        base64 "$f"
        echo "::ENDFILE::"
      fi
    done`,
  ], { workingDir: "/", timeout: 60_000 });

  const lines = result.stdout.split("\n");
  let currentPath = "";
  let currentSize = 0;
  let currentData: string[] = [];

  for (const line of lines) {
    if (line.startsWith("::FILE::")) {
      const parts = line.slice("::FILE::".length).split("::");
      currentPath = parts[0] ?? "";
      currentSize = parseInt(parts[1] ?? "0", 10);
      currentData = [];
    } else if (line === "::ENDFILE::") {
      if (currentPath && currentSize <= MAX_FILE_BYTES && totalBytes + currentSize <= MAX_TOTAL_BYTES) {
        const data = currentData.join("\n");
        totalBytes += currentSize;
        results.push({ path: currentPath, data, sizeBytes: currentSize });
      }
      currentPath = "";
      currentSize = 0;
      currentData = [];
    } else if (currentPath) {
      currentData.push(line);
    }
  }

  return results;
}

// -- Write files into container via putArchive --

export async function writeFiles(
  containerName: string,
  files: Array<{ path: string; data: Buffer }>,
  baseDir = "/workspace",
): Promise<void> {
  if (files.length === 0) return;
  const tar = buildTar(files.map(f => ({ path: f.path, data: f.data })));
  await docker.putArchive(containerName, baseDir, tar);
}

export async function deleteFiles(containerName: string, relativePaths: string[], baseDir = "/workspace"): Promise<void> {
  if (relativePaths.length === 0) return;
  const escaped = relativePaths.map(p => `'${baseDir}/${p}'`).join(" ");
  await docker.exec(containerName, [
    "bash", "-c", `rm -f ${escaped}`,
  ], { workingDir: "/" });
}

// -- Streaming tar helpers --

/**
 * Takes a Docker getArchive stream (tar containing a single file) and returns
 * a stream of just the inner file's content, without buffering the entire tar.
 *
 * Docker getArchive wraps the file in a tar: 512-byte header + data + padding + end blocks.
 * We parse the header from the first chunk(s), extract the file size, then pass through
 * exactly that many bytes of content.
 */
export function extractSingleFileStream(tarStream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = tarStream.getReader();
  let headerBuf: Uint8Array | null = null;
  let headerOffset = 0;
  let fileSize = -1;
  let bytesEmitted = 0;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }

          let chunk = value;
          // Phase 1: Collect 512-byte tar header
          if (fileSize === -1) {
            if (!headerBuf) headerBuf = new Uint8Array(512);
            const needed = 512 - headerOffset;
            const toCopy = Math.min(needed, chunk.byteLength);
            headerBuf.set(chunk.subarray(0, toCopy), headerOffset);
            headerOffset += toCopy;

            if (headerOffset < 512) continue; // need more data for header

            // Parse size from octal field at offset 124, length 12
            const sizeStr = new TextDecoder().decode(headerBuf.subarray(124, 136)).replace(/\0/g, "").trim();
            fileSize = parseInt(sizeStr, 8);
            if (isNaN(fileSize) || fileSize <= 0) {
              controller.close();
              reader.releaseLock();
              return;
            }

            // Remaining bytes after header in this chunk
            chunk = chunk.subarray(toCopy);
            headerBuf = null;
            if (chunk.byteLength === 0) continue;
          }

          // Phase 2: Pass through file content
          const remaining = fileSize - bytesEmitted;
          if (remaining <= 0) {
            controller.close();
            reader.releaseLock();
            return;
          }

          if (chunk.byteLength <= remaining) {
            controller.enqueue(chunk);
            bytesEmitted += chunk.byteLength;
          } else {
            controller.enqueue(chunk.subarray(0, remaining));
            bytesEmitted += remaining;
          }

          if (bytesEmitted >= fileSize) {
            controller.close();
            reader.releaseLock();
            return;
          }
          // Only pull one meaningful chunk per call for backpressure
          return;
        }
      } catch (err) {
        controller.error(err);
        reader.releaseLock();
      }
    },
    cancel() {
      reader.releaseLock();
      tarStream.cancel();
    },
  });
}

/**
 * Wraps a raw data stream in a tar archive stream (single file entry).
 * The file size must be known upfront (from Content-Length or stat).
 * Produces: 512-byte tar header + data chunks + padding + 1024-byte end marker.
 */
export function wrapInTarStream(filename: string, dataSize: number, dataStream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = dataStream.getReader();
  let headerSent = false;
  let bytesWritten = 0;
  let streamDone = false;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        // First: emit tar header
        if (!headerSent) {
          const header = Buffer.alloc(512);
          const nameBytes = Buffer.from(filename, "utf-8");
          nameBytes.copy(header, 0, 0, Math.min(nameBytes.length, 100));
          writeOctalHelper(header, 100, 8, 0o644);
          writeOctalHelper(header, 108, 8, 0);
          writeOctalHelper(header, 116, 8, 0);
          writeOctalHelper(header, 124, 12, dataSize);
          writeOctalHelper(header, 136, 12, Math.floor(Date.now() / 1000));
          header[156] = 0x30; // '0' = regular file
          Buffer.from("ustar\0", "ascii").copy(header, 257);
          Buffer.from("00", "ascii").copy(header, 263);
          // Checksum
          for (let i = 148; i < 156; i++) header[i] = 0x20;
          let checksum = 0;
          for (let i = 0; i < 512; i++) checksum += header[i]!;
          writeOctalHelper(header, 148, 7, checksum);
          header[155] = 0x20;

          controller.enqueue(new Uint8Array(header));
          headerSent = true;
          return;
        }

        // Stream data chunks
        if (!streamDone) {
          const { done, value } = await reader.read();
          if (done) {
            streamDone = true;
          } else {
            controller.enqueue(value);
            bytesWritten += value.byteLength;
            return;
          }
        }

        // After data: emit padding + end blocks
        reader.releaseLock();
        const remainder = bytesWritten % 512;
        const paddingSize = remainder > 0 ? 512 - remainder : 0;
        // Padding to 512-byte boundary + 1024-byte end marker
        const tail = Buffer.alloc(paddingSize + 1024);
        controller.enqueue(new Uint8Array(tail));
        controller.close();
      } catch (err) {
        controller.error(err);
        reader.releaseLock();
      }
    },
    cancel() {
      reader.releaseLock();
      dataStream.cancel();
    },
  });
}

function writeOctalHelper(buf: Buffer, offset: number, length: number, value: number): void {
  const str = value.toString(8).padStart(length - 1, "0");
  Buffer.from(str + "\0", "ascii").copy(buf, offset);
}

// -- Minimal tar builder/reader --

export function buildTar(files: Array<{ path: string; data: Buffer | Uint8Array }>): Buffer {
  const blocks: Buffer[] = [];

  for (const file of files) {
    const header = Buffer.alloc(512);
    const nameBytes = Buffer.from(file.path, "utf-8");
    nameBytes.copy(header, 0, 0, Math.min(nameBytes.length, 100));

    writeOctal(header, 100, 8, 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, file.data.length);
    writeOctal(header, 136, 12, Math.floor(Date.now() / 1000));
    header[156] = 0x30; // '0'
    Buffer.from("ustar\0", "ascii").copy(header, 257);
    Buffer.from("00", "ascii").copy(header, 263);

    for (let i = 148; i < 156; i++) header[i] = 0x20;
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += header[i]!;
    writeOctal(header, 148, 7, checksum);
    header[155] = 0x20;

    blocks.push(header);

    const data = Buffer.from(file.data);
    blocks.push(data);
    const remainder = data.length % 512;
    if (remainder > 0) {
      blocks.push(Buffer.alloc(512 - remainder));
    }
  }

  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

function writeOctal(buf: Buffer, offset: number, length: number, value: number): void {
  const str = value.toString(8).padStart(length - 1, "0");
  Buffer.from(str + "\0", "ascii").copy(buf, offset);
}

