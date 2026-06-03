import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Unauthenticated install endpoints for the laptop-side `zero` CLI.
 *
 *   GET /install.sh   → a POSIX shell installer, with this server's public
 *                       origin baked in, suitable for `curl … | sh`.
 *   GET /zero-cli.js  → the prebuilt CLI bundle the installer downloads.
 *
 * The bundle (zero/dist/cli.js) targets the Bun runtime, so the installer
 * makes sure Bun is present before dropping the executable on PATH. The
 * server image already ships zero/dist/cli.js (built in the Dockerfile), so
 * the same artifact the container runs is what laptops download.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// server/routes/install.ts → ../../zero/dist/cli.js
const CLI_BUNDLE_PATH = path.resolve(__dirname, "../../zero/dist/cli.js");

// Derive the public origin the laptop should talk back to. Honour the
// reverse-proxy forwarding headers when present, falling back to the request
// URL (direct connections in dev).
function publicOrigin(request: Request): string {
  const url = new URL(request.url);
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? url.host;
  const proto = request.headers.get("x-forwarded-proto") ?? url.protocol.replace(/:$/, "");
  return `${proto}://${host}`;
}

function installScript(origin: string): string {
  return `#!/bin/sh
# Installer for the zero CLI — connect a computer to ${origin}.
# Usage:  curl -fsSL ${origin}/install.sh | sh
set -e

ZERO_URL="${origin}"
INSTALL_DIR="\${ZERO_INSTALL_DIR:-$HOME/.zero/bin}"
BIN="$INSTALL_DIR/zero"

echo "Installing the zero CLI from $ZERO_URL"

# The CLI bundle targets the Bun runtime. Install Bun if it's missing.
if ! command -v bun >/dev/null 2>&1; then
  echo "Bun runtime not found — installing it from https://bun.sh …"
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="\${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "error: bun is still not on PATH. Restart your shell and re-run this installer." >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR"
echo "Downloading zero → $BIN"
curl -fsSL "$ZERO_URL/zero-cli.js" -o "$BIN"
chmod +x "$BIN"

# Install Playwright for the local-browser companion (\`zero browser connect\`).
# It MUST live under the zero home so the bundled CLI (run by Bun) can resolve
# a bare \`import("playwright")\` by walking up from <home>/bin/zero. A global
# \`npm i -g playwright\` lands in the npm prefix instead — off that path — so it
# would install successfully yet never be found. The runtime also self-heals on
# first use, so a failure here is non-fatal.
ZERO_HOME="\${ZERO_CONFIG_DIR:-$HOME/.zero}"
mkdir -p "$ZERO_HOME"
if [ ! -d "$ZERO_HOME/node_modules/playwright" ]; then
  echo ""
  echo "Installing Playwright for the local-browser companion…"
  ( cd "$ZERO_HOME" && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 bun add playwright ) \\
    || echo "warning: Playwright install failed; \\\`zero browser connect\\\` will retry on first use." >&2
fi
# Best-effort: fetch the bundled Chromium used only for \`--chromium\` / the
# fallback. The default companion path drives your installed Google Chrome and
# needs no download, so a failure here is fine.
if [ -f "$ZERO_HOME/node_modules/playwright/cli.js" ]; then
  ( cd "$ZERO_HOME" && bun "$ZERO_HOME/node_modules/playwright/cli.js" install chromium ) \\
    || echo "note: Chromium download skipped; your installed Chrome will be used." >&2
fi

# Add the install dir to PATH automatically by appending to the shell rc.
if ! { case ":$PATH:" in *":$INSTALL_DIR:"*) true ;; *) false ;; esac; }; then
  case "$(basename "\${SHELL:-sh}")" in
    zsh)  RC="$HOME/.zshrc" ;;
    bash) RC="$HOME/.bashrc" ;;
    *)    RC="$HOME/.profile" ;;
  esac
  if [ -f "$RC" ] && grep -qF "$INSTALL_DIR" "$RC" 2>/dev/null; then
    : # PATH entry already written on a previous run
  else
    printf '\\n# Added by the zero CLI installer\\nexport PATH="%s:$PATH"\\n' "$INSTALL_DIR" >> "$RC"
    echo ""
    echo "Added $INSTALL_DIR to PATH in $RC"
  fi
  echo "Open a new terminal (or run: source $RC) to pick up \\\`zero\\\`."
fi

echo ""
echo "Installed. Next, connect this computer:"
echo "  zero login --url $ZERO_URL"
echo "Then approve the code in the web app under Account → Companion."
`;
}

export async function handleInstallScript(request: Request): Promise<Response> {
  const script = installScript(publicOrigin(request));
  return new Response(script, {
    headers: {
      "Content-Type": "text/x-shellscript; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export async function handleCliDownload(_request: Request): Promise<Response> {
  try {
    const data = await readFile(CLI_BUNDLE_PATH);
    return new Response(data as unknown as BodyInit, {
      headers: {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return new Response("zero CLI bundle not found on this server\n", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}
