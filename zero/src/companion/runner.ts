/**
 * Companion runner — the long-lived process the user starts on their laptop
 * with `zero browser connect` (or `zero companion`). It:
 *
 *   1. opens an authenticated WebSocket to the server's `/ws/companion`
 *      endpoint using the saved companion token,
 *   2. drives the user's local Chrome via {@link CompanionEngine} in response
 *      to `command` control frames, and
 *   3. answers `ping` for liveness and reports capabilities on connect.
 *
 * It auto-reconnects with backoff so a flaky network or laptop sleep doesn't
 * permanently drop the project's browser. Uses the global `WebSocket` present
 * in both Bun and Node 22+.
 */
import { requireConfig } from "../sdk/config.ts";
import { CompanionEngine, type EngineOptions } from "./engine.ts";
import type { CompanionControl, CompanionMessage } from "../sdk/browser-protocol.ts";

export interface RunnerOptions extends EngineOptions {
  /** Called with human-readable status lines for the CLI to print. */
  onStatus?: (line: string) => void;
  /**
   * Called when the server permanently evicts this companion because another
   * computer connected as the same user (last-writer-wins). The runner stops
   * reconnecting; the CLI uses this to exit cleanly instead of hanging.
   */
  onTakenOver?: () => void;
}

/**
 * Close reason the server sends when a newer connection for the same user
 * displaces this one (see server companion registry). On this — unlike a
 * network blip — we must NOT reconnect, or the two machines fight forever.
 */
const REPLACED_REASON = "replaced";

const MAX_BACKOFF_MS = 30_000;

function wsUrl(baseUrl: string): string {
  const u = new URL(baseUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = "/ws/companion";
  return u.toString();
}

export class CompanionRunner {
  private engine: CompanionEngine;
  private ws: WebSocket | null = null;
  private stopped = false;
  private backoff = 1000;
  /** Set once the WS has opened at least once — distinguishes a transient drop
   *  from a link that has NEVER established (almost always auth/URL/proxy). */
  private everConnected = false;
  /** Consecutive closes without an intervening successful open. */
  private failedAttempts = 0;

  constructor(private opts: RunnerOptions) {
    this.engine = new CompanionEngine(opts);
  }

  private log(line: string): void {
    this.opts.onStatus?.(line);
  }

  async start(): Promise<void> {
    const cfg = requireConfig();
    const target = this.opts.cdpUrl
      ? `CDP ${this.opts.cdpUrl}`
      : this.opts.channel === undefined
        ? "bundled Chrome for Testing"
        : "your installed Google Chrome";
    this.log(`starting local browser (${target})…`);
    await this.engine.start();
    this.log(`connected to local Chrome — linking to ${cfg.projectName ?? "your project"}…`);
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    await this.engine.stop();
  }

  private connect(): void {
    if (this.stopped) return;
    const cfg = requireConfig();
    // The token travels as a WebSocket subprotocol, not a query param, so it
    // never lands in proxy access logs. The `zero-companion` marker MUST stay
    // first: the server echoes the first offered subprotocol in its handshake
    // response, and we want that to be the marker, never the secret.
    const ws = new WebSocket(wsUrl(cfg.baseUrl), ["zero-companion", cfg.token]);
    this.ws = ws;

    ws.onopen = () => {
      this.backoff = 1000;
      this.everConnected = true;
      this.failedAttempts = 0;
      this.log("✓ companion linked — the agent will now drive your browser");
      void this.sendStatus();
    };

    ws.onmessage = (ev: MessageEvent) => {
      let control: CompanionControl;
      try {
        control = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data)) as CompanionControl;
      } catch {
        return;
      }
      void this.handleControl(control);
    };

    ws.onclose = (ev: CloseEvent) => {
      this.ws = null;
      if (this.stopped) return;
      // A deliberate takeover from another computer: yield instead of
      // reconnecting, otherwise both machines evict each other in a loop.
      if ((ev?.reason ?? "").toLowerCase().includes(REPLACED_REASON)) {
        this.stopped = true;
        this.log("✗ another computer connected to this account and took over the browser link.");
        this.log("  Not reconnecting. Re-run `zero browser connect` here to take it back.");
        void this.engine.stop();
        this.opts.onTakenOver?.();
        return;
      }
      this.failedAttempts += 1;
      // Surface the close code/reason so an opaque "link dropped" becomes
      // diagnosable. A clean handshake rejection (bad/blocked token) shows up
      // as code 1006 with no reason; a server-side close carries a reason.
      const code = ev?.code ?? 0;
      const reason = ev?.reason ? ` "${ev.reason}"` : "";
      const detail = code ? ` (code ${code}${reason})` : reason;

      // If the link has NEVER come up, repeated failures are almost never a
      // transient network blip — the server is rejecting the upgrade. Point at
      // the usual culprits instead of looping silently forever.
      if (!this.everConnected && this.failedAttempts >= 2) {
        this.log(`✗ could not establish the companion link${detail}.`);
        this.log("  The server rejected the connection. Likely causes:");
        this.log("    • the session here is stale or for a different server — re-run `zero login --url <server>`");
        this.log("    • a network/VPN/corporate proxy is blocking the WebSocket upgrade or stripping headers");
        this.log("    • the --url doesn't match the server you logged into");
        this.log("  Still retrying in the background; fix the above and it will link automatically.");
      } else {
        this.log(`link dropped${detail}; reconnecting in ${Math.round(this.backoff / 1000)}s…`);
      }
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    };

    ws.onerror = () => {
      // onclose handles reconnect; swallow to avoid an unhandled error.
    };
  }

  private send(msg: CompanionMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private async sendStatus(): Promise<void> {
    const capabilities = await this.engine.capabilities();
    this.send({ type: "status", capabilities });
  }

  private async handleControl(control: CompanionControl): Promise<void> {
    switch (control.type) {
      case "ping":
        this.send({ type: "pong" });
        break;
      case "command": {
        const { id, action } = control.command;
        try {
          const result = await this.engine.execute(action);
          this.send({ type: "response", response: { id, result } });
        } catch (err) {
          this.send({
            type: "response",
            response: { id, error: err instanceof Error ? err.message : String(err) },
          });
        }
        break;
      }
      default:
        // Workspace / session / webauthn control frames are not yet supported
        // by this runner; ignore them rather than crashing.
        break;
    }
  }
}
