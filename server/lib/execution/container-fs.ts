/**
 * In-container filesystem operations — all file I/O goes through Docker exec
 * or the Docker archive API. No host filesystem access.
 */
import { docker } from "@/lib/docker-client.ts";
import { log } from "@/lib/logger.ts";

const fsLog = log.child({ module: "container-fs" });

const IGNORED_DIRS = new Set([".venv", "node_modules", ".tmp", "__pycache__", ".git"]);
const FIND_PRUNE_ARGS = [...IGNORED_DIRS].map(d => `-name ${d} -prune`).join(" -o ");

const MAX_FILE_BYTES = 10 * 1024 * 1024;   // 10 MB per file
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;   // 50 MB total

const SYSTEM_SNAPSHOT_EXCLUDES = [
  "./workspace", "./proc", "./sys", "./dev", "./tmp", "./run", "./var/run",
  "./etc/hostname", "./etc/hosts", "./etc/resolv.conf",
].map(d => `--exclude=${d}`).join(" ");

// ── Marker-based change detection ──

export async function touchMarker(containerName: string): Promise<void> {
  await docker.exec(containerName, ["bash", "-c", "touch /tmp/.snapshot-marker"], { workingDir: "/" });
}

export async function listWorkspaceFiles(containerName: string): Promise<Set<string>> {
  const result = await docker.exec(containerName, [
    "bash", "-c",
    `find /workspace \\( ${FIND_PRUNE_ARGS} \\) -o -type f -print`,
  ], { workingDir: "/" });
  const files = new Set<string>();
  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && trimmed.startsWith("/workspace/")) {
      files.add(trimmed.slice("/workspace/".length));
    }
  }
  return files;
}

export interface DetectedChanges {
  changed: string[];   // relative paths under /workspace
  deleted: string[];   // relative paths under /workspace
}

export async function detectChanges(
  containerName: string,
  preFileList: Set<string>,
): Promise<DetectedChanges> {
  // Find files newer than the marker (changed or new)
  const findResult = await docker.exec(containerName, [
    "bash", "-c",
    `find /workspace \\( ${FIND_PRUNE_ARGS} \\) -o -type f -newer /tmp/.snapshot-marker -print`,
  ], { workingDir: "/" });

  const changed: string[] = [];
  for (const line of findResult.stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && trimmed.startsWith("/workspace/")) {
      changed.push(trimmed.slice("/workspace/".length));
    }
  }

  // Detect deletions by comparing current file list to pre-exec list
  const postFileList = await listWorkspaceFiles(containerName);
  const deleted: string[] = [];
  for (const file of preFileList) {
    if (!postFileList.has(file)) {
      deleted.push(file);
    }
  }

  return { changed, deleted };
}

// ── Read files from container ──

export interface ReadFile {
  path: string;
  data: string;        // base64
  sizeBytes: number;
}

export async function readFiles(containerName: string, relativePaths: string[]): Promise<ReadFile[]> {
  if (relativePaths.length === 0) return [];

  const results: ReadFile[] = [];
  let totalBytes = 0;

  // For each file: output a header line with path and size, then base64 content
  const escaped = relativePaths.map(p => `'/workspace/${p}'`).join(" ");
  const result = await docker.exec(containerName, [
    "bash", "-c",
    `for f in ${escaped}; do
      if [ -f "$f" ]; then
        sz=$(stat -c%s "$f" 2>/dev/null || echo 0)
        rel="\${f#/workspace/}"
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

// ── Write files into container via putArchive ──

export async function writeFiles(
  containerName: string,
  files: Array<{ relativePath: string; data: Buffer }>,
): Promise<void> {
  if (files.length === 0) return;

  // Build a tar archive in memory and upload via Docker archive API
  const tar = buildTar(files.map(f => ({ path: f.relativePath, data: f.data })));
  await docker.putArchive(containerName, "/workspace", tar);
}

export async function deleteFiles(containerName: string, relativePaths: string[]): Promise<void> {
  if (relativePaths.length === 0) return;
  const escaped = relativePaths.map(p => `'/workspace/${p}'`).join(" ");
  await docker.exec(containerName, [
    "bash", "-c", `rm -f ${escaped}`,
  ], { workingDir: "/" });
}

// ── System snapshot (everything outside /workspace) via Docker archive API ──

export async function saveSystemSnapshot(containerName: string): Promise<Buffer | null> {
  try {
    // Create tar inside container, then extract via getArchive
    const result = await docker.exec(containerName, [
      "bash", "-c",
      `tar czf /tmp/system-snapshot.tar.gz -C / ${SYSTEM_SNAPSHOT_EXCLUDES} . 2>/dev/null; echo done`,
    ], { workingDir: "/", timeout: 120_000 });

    if (result.exitCode !== 0) {
      fsLog.warn("system snapshot tar failed", { stderr: result.stderr });
      return null;
    }

    // Use getArchive to pull the tarball out — this returns a tar containing the file
    const outerTar = await docker.getArchive(containerName, "/tmp/system-snapshot.tar.gz");

    // Clean up
    docker.exec(containerName, ["rm", "-f", "/tmp/system-snapshot.tar.gz"], { workingDir: "/" }).catch(() => {});

    // The Docker getArchive API wraps the file in a tar, so we need to extract
    // the inner file from the outer tar
    const inner = extractSingleFileFromTar(outerTar);
    if (!inner) {
      fsLog.warn("failed to extract system snapshot from archive response");
      return null;
    }

    fsLog.info("system snapshot saved", { sizeBytes: inner.byteLength });
    return inner;
  } catch (err) {
    fsLog.warn("failed to save system snapshot", { error: String(err) });
    return null;
  }
}

export async function restoreSystemSnapshot(containerName: string, buffer: Buffer): Promise<boolean> {
  try {
    // Wrap the .tar.gz in a tar so putArchive can place it at /tmp/
    const wrappedTar = buildTar([{ path: "system-snapshot.tar.gz", data: buffer }]);
    await docker.putArchive(containerName, "/tmp", wrappedTar);

    // Extract inside container
    const result = await docker.exec(containerName, [
      "bash", "-c",
      `tar xzf /tmp/system-snapshot.tar.gz -C / 2>/dev/null; rm -f /tmp/system-snapshot.tar.gz`,
    ], { workingDir: "/", timeout: 120_000 });

    if (result.exitCode !== 0) {
      fsLog.warn("system snapshot restore failed", { stderr: result.stderr });
      return false;
    }

    fsLog.info("system snapshot restored");
    return true;
  } catch (err) {
    fsLog.warn("failed to restore system snapshot", { error: String(err) });
    return false;
  }
}

// ── Workspace snapshot (just /workspace, for project file sync on destroy) ──

export async function saveWorkspaceFiles(containerName: string): Promise<ReadFile[]> {
  const fileList = await listWorkspaceFiles(containerName);
  return readFiles(containerName, [...fileList]);
}

// ── Minimal tar builder/reader ──

/** Build a POSIX tar archive (uncompressed) from a list of files. */
function buildTar(files: Array<{ path: string; data: Buffer | Uint8Array }>): Buffer {
  const blocks: Buffer[] = [];

  for (const file of files) {
    const header = Buffer.alloc(512);
    const nameBytes = Buffer.from(file.path, "utf-8");
    nameBytes.copy(header, 0, 0, Math.min(nameBytes.length, 100));

    // File mode: 0644
    writeOctal(header, 100, 8, 0o644);
    // Owner/group ID: 0
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    // File size
    writeOctal(header, 124, 12, file.data.length);
    // Mtime: now
    writeOctal(header, 136, 12, Math.floor(Date.now() / 1000));
    // Type flag: regular file
    header[156] = 0x30; // '0'
    // Magic
    Buffer.from("ustar\0", "ascii").copy(header, 257);
    // Version
    Buffer.from("00", "ascii").copy(header, 263);

    // Compute checksum
    // First fill checksum field with spaces
    for (let i = 148; i < 156; i++) header[i] = 0x20;
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += header[i]!;
    writeOctal(header, 148, 7, checksum);
    header[155] = 0x20; // trailing space

    blocks.push(header);

    // File data, padded to 512-byte blocks
    const data = Buffer.from(file.data);
    blocks.push(data);
    const remainder = data.length % 512;
    if (remainder > 0) {
      blocks.push(Buffer.alloc(512 - remainder));
    }
  }

  // Two empty blocks as end-of-archive marker
  blocks.push(Buffer.alloc(1024));

  return Buffer.concat(blocks);
}

function writeOctal(buf: Buffer, offset: number, length: number, value: number): void {
  const str = value.toString(8).padStart(length - 1, "0");
  Buffer.from(str + "\0", "ascii").copy(buf, offset);
}

/** Extract the first file's content from a tar archive (for Docker getArchive responses). */
function extractSingleFileFromTar(tar: Buffer): Buffer | null {
  if (tar.length < 512) return null;

  // Read size from header at offset 124, 12 bytes octal
  const sizeStr = tar.subarray(124, 136).toString("ascii").replace(/\0/g, "").trim();
  const size = parseInt(sizeStr, 8);
  if (isNaN(size) || size <= 0) return null;

  if (tar.length < 512 + size) return null;
  return Buffer.from(tar.subarray(512, 512 + size));
}
