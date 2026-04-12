/**
 * In-container filesystem operations — all file I/O goes through Docker exec
 * or the Docker archive API. No host filesystem access.
 */
import { docker } from "./docker-client.ts";
import { log } from "./logger.ts";

const fsLog = log.child({ module: "container-fs" });

/**
 * Static fallback for projects without a .gitignore (or before the first
 * detectBlobDirs call). Always-opaque dirs that should never appear in the
 * source-file change feed.
 */
export const STATIC_BLOB_DIRS = [".git", ".tmp"];

function buildPruneArgs(dirs: readonly string[]): string {
  if (dirs.length === 0) return "-false";
  return dirs.map(d => `-name ${shellQuote(d)} -prune`).join(" -o ");
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Detect "opaque" workspace directories — anything ignored by `.gitignore`
 * (plus `.git`/`.tmp` always). Used to prune the source-file change feed and
 * to drive blob-dir tarball persistence.
 */
export async function detectBlobDirs(containerName: string): Promise<string[]> {
  const script = `
set -e
cd /project 2>/dev/null || exit 0
echo .git
echo .tmp
if [ -f .gitignore ]; then
  for entry in */; do
    d="\${entry%/}"
    if [ "$d" = ".git" ] || [ "$d" = ".tmp" ]; then continue; fi
    if git check-ignore --no-index -q "$d" 2>/dev/null; then
      echo "$d"
    fi
  done
fi
`;
  try {
    const result = await docker.exec(containerName, ["bash", "-c", script], {
      workingDir: "/", timeout: 15_000,
    });
    const seen = new Set<string>();
    for (const line of result.stdout.split("\n")) {
      const trimmed = line.trim();
      if (trimmed) seen.add(trimmed);
    }
    return [...seen];
  } catch {
    return [...STATIC_BLOB_DIRS];
  }
}

const MAX_FILE_BYTES = 10 * 1024 * 1024;   // 10 MB per file
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;   // 50 MB total

const SYSTEM_SNAPSHOT_EXCLUDES = [
  "./project", "./proc", "./sys", "./dev", "./tmp", "./run", "./var/run",
  "./etc/hostname", "./etc/hosts", "./etc/resolv.conf",
  // The `zero` CLI/SDK is baked into the image and must track image
  // upgrades — never freeze it inside a per-project snapshot.
  "./opt/zero",
].map(d => `--exclude=${d}`).join(" ");

// -- Marker-based change detection --

export async function touchMarker(containerName: string): Promise<void> {
  await docker.exec(containerName, ["bash", "-c", "touch /tmp/.snapshot-marker"], { workingDir: "/" });
}

export async function listFiles(
  containerName: string,
  dir = "/project",
  blobDirs: readonly string[] = STATIC_BLOB_DIRS,
): Promise<Set<string>> {
  const pruneArgs = buildPruneArgs(blobDirs);
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
  dir = "/project",
  blobDirs: readonly string[] = STATIC_BLOB_DIRS,
): Promise<Record<string, string>> {
  const pruneArgs = buildPruneArgs(blobDirs);
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

export interface DetectedChanges {
  changed: string[];
  deleted: string[];
}

export async function detectChanges(
  containerName: string,
  preFileList: Set<string>,
  dir = "/project",
  blobDirs: readonly string[] = STATIC_BLOB_DIRS,
): Promise<DetectedChanges> {
  const prefix = dir.endsWith("/") ? dir : dir + "/";
  const pruneArgs = buildPruneArgs(blobDirs);

  const findResult = await docker.exec(containerName, [
    "bash", "-c",
    `find ${dir} \\( ${pruneArgs} \\) -o -type f -newer /tmp/.snapshot-marker -print`,
  ], { workingDir: "/" });

  const changed: string[] = [];
  for (const line of findResult.stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && trimmed.startsWith(prefix)) {
      changed.push(trimmed.slice(prefix.length));
    }
  }

  const postFileList = await listFiles(containerName, dir, blobDirs);
  const deleted: string[] = [];
  for (const file of preFileList) {
    if (!postFileList.has(file)) {
      deleted.push(file);
    }
  }

  return { changed, deleted };
}

// -- Read files from container --

export interface ReadFile {
  path: string;
  data: string;        // base64
  sizeBytes: number;
}

export async function readFiles(containerName: string, relativePaths: string[], baseDir = "/project"): Promise<ReadFile[]> {
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
  baseDir = "/project",
): Promise<void> {
  if (files.length === 0) return;
  const tar = buildTar(files.map(f => ({ path: f.path, data: f.data })));
  await docker.putArchive(containerName, baseDir, tar);
}

export async function deleteFiles(containerName: string, relativePaths: string[], baseDir = "/project"): Promise<void> {
  if (relativePaths.length === 0) return;
  const escaped = relativePaths.map(p => `'${baseDir}/${p}'`).join(" ");
  await docker.exec(containerName, [
    "bash", "-c", `rm -f ${escaped}`,
  ], { workingDir: "/" });
}

// -- System snapshot (everything outside /project) --

export async function saveSystemSnapshot(containerName: string): Promise<Buffer | null> {
  try {
    const result = await docker.exec(containerName, [
      "bash", "-c",
      `tar czf /tmp/system-snapshot.tar.gz -C / ${SYSTEM_SNAPSHOT_EXCLUDES} . 2>&1 || true`,
    ], { workingDir: "/", timeout: 120_000 });

    if (result.exitCode !== 0) {
      fsLog.warn("system snapshot tar failed", { stderr: result.stderr });
      return null;
    }

    const outerTar = await docker.getArchive(containerName, "/tmp/system-snapshot.tar.gz");
    docker.exec(containerName, ["rm", "-f", "/tmp/system-snapshot.tar.gz"], { workingDir: "/" }).catch(() => {});

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
    const wrappedTar = buildTar([{ path: "system-snapshot.tar.gz", data: buffer }]);
    await docker.putArchive(containerName, "/tmp", wrappedTar);

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

// -- Workspace blob dir snapshots (per-dir tarballs) --

function safeBlobName(dir: string): string {
  return dir.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export async function tarWorkspaceDir(containerName: string, dir: string): Promise<Buffer | null> {
  try {
    const safe = safeBlobName(dir);
    const target = `/tmp/blob-${safe}.tar.gz`;
    const result = await docker.exec(containerName, [
      "bash", "-c",
      `cd /project && [ -e ${shellQuote(dir)} ] && tar czf ${shellQuote(target)} ${shellQuote(dir)} 2>&1 || exit 9`,
    ], { workingDir: "/", timeout: 120_000 });

    if (result.exitCode === 9) return null; // dir doesn't exist
    if (result.exitCode !== 0) {
      fsLog.warn("blob tar failed", { dir, stderr: result.stderr });
      return null;
    }

    const outerTar = await docker.getArchive(containerName, target);
    docker.exec(containerName, ["rm", "-f", target], { workingDir: "/" }).catch(() => {});
    const inner = extractSingleFileFromTar(outerTar);
    if (!inner) {
      fsLog.warn("blob extract failed", { dir });
      return null;
    }
    return inner;
  } catch (err) {
    fsLog.warn("tarWorkspaceDir failed", { dir, error: String(err) });
    return null;
  }
}

export async function untarWorkspaceDir(containerName: string, dir: string, data: Buffer): Promise<boolean> {
  try {
    const safe = safeBlobName(dir);
    const inner = `blob-${safe}.tar.gz`;
    const wrapped = buildTar([{ path: inner, data }]);
    await docker.putArchive(containerName, "/tmp", wrapped);

    const result = await docker.exec(containerName, [
      "bash", "-c",
      `mkdir -p /project && cd /project && tar xzf /tmp/${inner} 2>/dev/null; rm -f /tmp/${inner}`,
    ], { workingDir: "/", timeout: 120_000 });

    if (result.exitCode !== 0) {
      fsLog.warn("blob untar failed", { dir, stderr: result.stderr });
      return false;
    }
    return true;
  } catch (err) {
    fsLog.warn("untarWorkspaceDir failed", { dir, error: String(err) });
    return false;
  }
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

function extractSingleFileFromTar(tar: Buffer): Buffer | null {
  if (tar.length < 512) return null;
  const sizeStr = tar.subarray(124, 136).toString("ascii").replace(/\0/g, "").trim();
  const size = parseInt(sizeStr, 8);
  if (isNaN(size) || size <= 0) return null;
  if (tar.length < 512 + size) return null;
  return Buffer.from(tar.subarray(512, 512 + size));
}
