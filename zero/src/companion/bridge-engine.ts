/**
 * Bridge engine — the laptop end of the companion link.
 *
 * Replaces the old Playwright {@link CompanionEngine}. Instead of launching and
 * locking the user's Chrome profile (the source of every profile-lock /
 * keychain / flag-fighting bug), this runs a tiny localhost WebSocket server
 * and forwards each {@link BrowserAction} to the **Zero Companion browser
 * extension**, which executes it against the user's real, already-open tab via
 * `chrome.debugger`. The user keeps browsing; nothing is launched or locked.
 *
 * It exposes the exact surface {@link CompanionRunner} expects
 * (`start`/`stop`/`execute`/`capabilities`/`isAlive`), so the server-facing
 * protocol is unchanged — the server can't tell this from the headless pool.
 *
 * Security: the server binds 127.0.0.1 only and requires the extension to
 * present a one-time secret (written into the extension's own directory) before
 * any command is accepted, so other local processes/pages can't drive Chrome.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { WebSocketServer, WebSocket } from "ws";
import { zeroHomeDir } from "../sdk/config.ts";
import type { BrowserAction, BrowserResult } from "../sdk/browser-protocol.ts";
import { EXTENSION_ASSETS } from "./extension-assets.ts";

export interface EngineOptions {
  /** Sink for non-fatal warnings. */
  onWarn?: (line: string) => void;
  /** Sink for human-readable status lines (shared with the runner). */
  onStatus?: (line: string) => void;
}

/** How long a single forwarded action may take before we give up (matches the server's 90s). */
const COMMAND_TIMEOUT_MS = 90_000;
/** Grace period to see if the extension is already installed and live. */
const INITIAL_WAIT_MS = 2_500;
/**
 * `connect` wait for the extension's worker to (re)connect. Sized to exceed the
 * extension's 30s service-worker wake alarm so a dormant-but-installed worker
 * is reliably picked up.
 */
const CONNECT_WAIT_MS = 35_000;
/** How long `setup` keeps waiting for first install before giving up. */
const INSTALL_WAIT_MS = 10 * 60_000;
/** Re-print a gentle nudge on this cadence while waiting for first install. */
const NUDGE_MS = 45_000;
/**
 * Ping the extension on this cadence. Must stay under Chrome's 30s MV3
 * service-worker idle kill: an incoming WS message resets that timer
 * (Chrome 116+), so this keeps the extension's worker alive between commands.
 */
const KEEPALIVE_MS = 20_000;

interface Pending {
  resolve: (r: BrowserResult) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class BridgeEngine {
  private wss: WebSocketServer | null = null;
  private ext: WebSocket | null = null;
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private pending = new Map<string, Pending>();
  private seq = 0;
  private extDir = join(zeroHomeDir(), "extension");
  private secret = randomBytes(24).toString("base64url");
  /** Resolves the moment a verified extension connects. */
  private connectedWaiters: Array<() => void> = [];

  constructor(private opts: EngineOptions) {}

  private warn(line: string): void {
    this.opts.onWarn?.(line);
  }
  private status(line: string): void {
    this.opts.onStatus?.(line);
  }

  private async prepare(): Promise<void> {
    this.materializeExtension();
    await this.listen();
    this.writeBridgeConfig();
  }

  /**
   * `zero browser connect` — link to an extension that's already installed.
   * Does NOT walk through install; if nothing connects, points at `setup`.
   */
  async start(): Promise<void> {
    await this.prepare();
    this.status("linking to your browser…");
    if (await this.waitForExtension(CONNECT_WAIT_MS)) return;
    throw new Error(
      "Couldn't reach the Zero Companion extension.\n" +
        "Run `zero browser setup` once to add it to Chrome, make sure Chrome is open, then try again.",
    );
  }

  /**
   * `zero browser setup` — one-time install of the extension into Chrome.
   * Chrome 137+ disabled --load-extension, so the only no-store path is
   * Load-unpacked: open the page, reveal the folder to drag in, and block until
   * the extension connects (confirming it works). Once loaded it persists.
   */
  async setup(): Promise<void> {
    await this.prepare();
    if (await this.waitForExtension(INITIAL_WAIT_MS)) {
      this.status("✓ Zero Companion is already set up — run `zero browser connect` to start.");
      return;
    }
    this.printInstallGuide();
    this.openExtensionsPage();
    this.revealExtensionFolder();
    if (await this.waitForInstall()) {
      this.status("");
      this.status("✓ Zero Companion is set up. Run `zero browser connect` to start.");
      return;
    }
    throw new Error(
      "Timed out waiting for the Zero Companion extension. Once you've added it in " +
        `chrome://extensions (Developer mode → Load unpacked → ${this.extDir}), run \`zero browser setup\` again.`,
    );
  }

  /** Print the one-time, copy-pasteable setup steps. */
  private printInstallGuide(): void {
    const mac = process.platform === "darwin";
    const lines = [
      "",
      "──────────────────────────────────────────────────────────────",
      "  One-time setup — add the Zero Companion extension to Chrome",
      "──────────────────────────────────────────────────────────────",
      "  1. Chrome should have opened chrome://extensions.",
      "     (If not, open that page yourself.)",
      "  2. Turn ON \"Developer mode\" — the toggle in the top-right.",
      mac
        ? "  3. Drag the \"extension\" folder from the Finder window that"
        : "  3. Click \"Load unpacked\" and choose this folder:",
      mac ? "     just opened onto the chrome://extensions page." : `       ${this.extDir}`,
      mac ? "     (or click \"Load unpacked\" and choose the folder below)." : "",
      mac ? `     Folder: ${this.extDir}` : "",
      "──────────────────────────────────────────────────────────────",
      "  Waiting for the extension to connect… (leave this running)",
      "",
    ].filter((l) => l !== "");
    for (const l of lines) this.status(l);
  }

  private openExtensionsPage(): void {
    // Best-effort; the printed steps cover it if the OS blocks the deep link.
    if (process.platform === "darwin") {
      this.spawnDetached("open", ["-a", "Google Chrome", "chrome://extensions/"]);
    } else if (process.platform === "win32") {
      this.spawnDetached("cmd", ["/c", "start", "chrome", "chrome://extensions/"]);
    } else {
      this.spawnDetached("google-chrome", ["chrome://extensions/"]);
    }
  }

  private revealExtensionFolder(): void {
    if (process.platform === "darwin") this.spawnDetached("open", ["-R", this.extDir]);
  }

  private spawnDetached(cmd: string, args: string[]): void {
    try {
      const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
      child.on("error", () => {});
      child.unref();
    } catch {
      /* best-effort */
    }
  }

  async stop(): Promise<void> {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("companion stopped"));
    }
    this.pending.clear();
    this.stopKeepalive();
    this.ext = null;
    const wss = this.wss;
    this.wss = null;
    if (!wss) return;
    // Force-terminate any lingering client sockets: `ws` under bun won't fire
    // the close callback while clients remain connected, so a graceful close()
    // alone would hang. terminate() drops them immediately; the timeout is a
    // belt-and-braces fallback so stop() always resolves (e.g. on Ctrl-C).
    for (const c of wss.clients) {
      try {
        c.terminate();
      } catch {
        /* ignore */
      }
    }
    await new Promise<void>((resolve) => {
      let done = false;
      const fin = () => {
        if (done) return;
        done = true;
        resolve();
      };
      wss.close(() => fin());
      const t = setTimeout(fin, 1_000);
      if (typeof t.unref === "function") t.unref();
    });
  }

  isAlive(): boolean {
    return !!this.ext && this.ext.readyState === WebSocket.OPEN;
  }

  async capabilities(): Promise<{ dockerInstalled: boolean; dockerRunning: boolean; chromeAvailable: boolean }> {
    return { dockerInstalled: false, dockerRunning: false, chromeAvailable: this.isAlive() };
  }

  execute(action: BrowserAction): Promise<BrowserResult> {
    if (!this.isAlive()) {
      return Promise.reject(
        new Error(
          "The Zero Companion browser extension isn't connected. Make sure Chrome is open with the extension enabled, then re-run `zero browser connect`.",
        ),
      );
    }
    const ext = this.ext!;
    const id = `b${++this.seq}`;
    return new Promise<BrowserResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`browser action timed out after ${COMMAND_TIMEOUT_MS}ms`));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        ext.send(JSON.stringify({ type: "command", id, action }));
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  // ── internals ──

  private listen(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // Ephemeral port on loopback only; the extension reads the chosen port
      // from bridge.json, so the exact number doesn't matter.
      const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      wss.on("connection", (ws) => this.onConnection(ws));
      wss.on("listening", () => {
        this.wss = wss;
        resolve();
      });
      wss.on("error", (err) => reject(err));
    });
  }

  private port(): number {
    const addr = this.wss?.address();
    return typeof addr === "object" && addr ? addr.port : 0;
  }

  private onConnection(ws: WebSocket): void {
    let verified = false;
    ws.on("message", (data) => {
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!verified) {
        // First frame must be the hello carrying the shared secret.
        if (msg.type === "hello" && msg.secret === this.secret) {
          verified = true;
          this.ext = ws;
          this.startKeepalive();
          this.status("✓ browser helper connected — the agent can now drive your tab");
          const waiters = this.connectedWaiters;
          this.connectedWaiters = [];
          for (const fn of waiters) fn();
        } else {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
        }
        return;
      }
      this.handleExtMessage(msg);
    });
    ws.on("close", () => {
      if (this.ext === ws) {
        this.ext = null;
        this.stopKeepalive();
      }
    });
    ws.on("error", () => {
      /* close handler does cleanup */
    });
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    const t = setInterval(() => {
      try {
        if (this.ext?.readyState === WebSocket.OPEN) this.ext.send(JSON.stringify({ type: "ping" }));
      } catch {
        /* ignore */
      }
    }, KEEPALIVE_MS);
    if (typeof t.unref === "function") t.unref();
    this.keepalive = t;
  }

  private stopKeepalive(): void {
    if (this.keepalive) {
      clearInterval(this.keepalive);
      this.keepalive = null;
    }
  }

  private handleExtMessage(msg: any): void {
    switch (msg.type) {
      case "ping":
        try {
          this.ext?.send(JSON.stringify({ type: "pong" }));
        } catch {
          /* ignore */
        }
        break;
      case "pong":
        break;
      case "response": {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error));
        else if (msg.result) p.resolve(msg.result as BrowserResult);
        else p.reject(new Error("extension returned an empty result"));
        break;
      }
      default:
        break;
    }
  }

  private waitForExtension(timeout: number): Promise<boolean> {
    if (this.isAlive()) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      this.connectedWaiters.push(() => done(true));
      setTimeout(() => done(this.isAlive()), timeout);
    });
  }

  /**
   * Block until the extension connects (first-time install), nudging every so
   * often so the wait doesn't look frozen. Resolves true on connect, false on
   * the overall INSTALL_WAIT_MS timeout.
   */
  private async waitForInstall(): Promise<boolean> {
    const deadline = Date.now() + INSTALL_WAIT_MS;
    while (Date.now() < deadline) {
      const slice = Math.min(NUDGE_MS, deadline - Date.now());
      if (await this.waitForExtension(slice)) return true;
      if (Date.now() < deadline) {
        this.status("… still waiting — finish the steps above in chrome://extensions");
      }
    }
    return this.isAlive();
  }

  private materializeExtension(): void {
    mkdirSync(this.extDir, { recursive: true });
    for (const [name, content] of Object.entries(EXTENSION_ASSETS)) {
      writeFileSync(join(this.extDir, name), content);
    }
  }

  private writeBridgeConfig(): void {
    const cfg = JSON.stringify({ port: this.port(), secret: this.secret });
    writeFileSync(join(this.extDir, "bridge.json"), cfg);
  }
}
