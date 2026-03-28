import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";

const UV_DIR = path.join(os.homedir(), ".companion", "uv");
const UV_BIN = path.join(UV_DIR, process.platform === "win32" ? "uv.exe" : "uv");

let cachedPath: string | null = null;

function getDownloadTarget(): { filename: string; isZip: boolean } {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "darwin" && arch === "arm64") return { filename: "uv-aarch64-apple-darwin.tar.gz", isZip: false };
  if (platform === "darwin" && arch === "x64") return { filename: "uv-x86_64-apple-darwin.tar.gz", isZip: false };
  if (platform === "linux" && arch === "x64") return { filename: "uv-x86_64-unknown-linux-gnu.tar.gz", isZip: false };
  if (platform === "win32" && arch === "x64") return { filename: "uv-x86_64-pc-windows-msvc.zip", isZip: true };

  throw new Error(`Unsupported platform: ${platform}/${arch}`);
}

export async function ensureUv(): Promise<string> {
  if (cachedPath) return cachedPath;

  // Check if already downloaded
  try {
    await fs.access(UV_BIN);
    cachedPath = UV_BIN;
    return UV_BIN;
  } catch {
    // Need to download
  }

  await fs.mkdir(UV_DIR, { recursive: true });

  const { filename, isZip } = getDownloadTarget();
  const url = `https://github.com/astral-sh/uv/releases/latest/download/${filename}`;
  const archivePath = path.join(UV_DIR, filename);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download uv: ${res.status} ${res.statusText}`);
  }
  const buffer = await res.arrayBuffer();
  await Bun.write(archivePath, buffer);

  if (isZip) {
    Bun.spawnSync([
      "powershell", "-Command",
      `Expand-Archive -Path '${archivePath}' -DestinationPath '${UV_DIR}' -Force`,
    ]);
    // Move binary from nested directory to UV_DIR root
    const nested = path.join(UV_DIR, filename.replace(".zip", ""), "uv.exe");
    try {
      await fs.rename(nested, UV_BIN);
    } catch {
      // Binary may already be at the right location
    }
  } else {
    Bun.spawnSync(["tar", "xzf", archivePath, "-C", UV_DIR, "--strip-components=1"]);
  }

  // Clean up archive
  await fs.unlink(archivePath).catch(() => {});

  // Ensure executable on Unix
  if (process.platform !== "win32") {
    await fs.chmod(UV_BIN, 0o755);
  }

  cachedPath = UV_BIN;
  return UV_BIN;
}
