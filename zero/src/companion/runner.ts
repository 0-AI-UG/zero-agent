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
 * permanently drop the project's browser.
 *
 * Transport: we use the `ws` library's WebSocket rather than the global one so
 * we can set request headers. The companion token rides in the
 * `x-zero-companion-token` REQUEST header — keeping it out of the URL (access
 * logs) and the handshake response — and we offer NO WebSocket subprotocol.
 *
 * History: the token used to ride as a second subprotocol, then as a single
 * `zero-companion` subprotocol with the token moved to a header. Both leaned on
 * the server echoing back `Sec-WebSocket-Protocol`, which reverse proxies
 * mishandle: some Bun versions closed the socket with 1002 "Mismatch client
 * protocol", and a deployed proxy was severing the upgraded socket within a
 * second — while the cookie/query-token chat `/ws` (no subprotocol) stayed up
 * through the same proxy. So we drop the subprotocol entirely and connect like
 * the chat socket does.
 */
import { WebSocket } from "ws";
import { requireConfig, getOrCreateDeviceId } from "../sdk/config.ts";
import { CompanionEngine, type EngineOptions } from "./engine.ts";
import type { CompanionControl, CompanionMessage } from "../sdk/browser-protocol.ts";

export interface RunnerOptions extends EngineOptions {
  /** Called with human-readable status lines for the CLI to print. */
  onStatus?: (line: string) => void;
  /**
   * Called when the server permanently evicts this companion because a newer
   * connection for the same user took over the link — either another computer
   * (a real takeover) or a fresh connection from this same computer (a routine
   * hand-off). Either way the runner stops reconnecting; the CLI uses this to
   * exit cleanly instead of hanging.
   */
  onTakenOver?: () => void;
}

/**
 * Close reason the server sends when a newer connection from a DIFFERENT
 * computer displaces this one (see server companion registry). On this — unlike
 * a network blip — we must NOT reconnect, or the two machines fight forever.
 */
const REPLACED_REASON = "replaced";

/**
 * Close reason the server sends when a newer connection from the SAME computer
 * (matching deviceId) takes over — e.g. the user re-ran `zero browser connect`
 * here while this process was still in a background reconnect loop. A routine
 * hand-off, not a takeover: step aside quietly without the alarming message,
 * and (like a takeover) do NOT reconnect, so the two never ping-pong.
 */
const SUPERSEDED_REASON = "superseded";

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
    const binary = this.opts.channel === undefined ? "bundled Chrome for Testing" : "your installed Google Chrome";
    const target = this.opts.cdpUrl
      ? `CDP ${this.opts.cdpUrl}`
      : this.opts.fresh
        ? `${binary}, clean profile`
        : `${binary}, your real profile`;
    this.log(`starting local browser (${target})…`);
    if (!this.opts.cdpUrl && !this.opts.fresh) {
      this.log("note: using your real Chrome profile — quit Google Chrome first if it's open, or it can't be driven.");
    }
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
    // Token in a request header (kept out of the URL and the handshake
    // response). No subprotocol — an empty protocols array — so there is no
    // `Sec-WebSocket-Protocol` echo for a proxy to mishandle.
    const ws = new WebSocket(wsUrl(cfg.baseUrl), [], {
      headers: {
        "x-zero-companion-token": cfg.token,
        // Identifies this machine so the server can tell a same-computer
        // reconnect/hand-off from a real takeover by another computer.
        "x-zero-companion-device": getOrCreateDeviceId(),
      },
    });
    this.ws = ws;

    ws.onopen = () => {
      this.backoff = 1000;
      this.everConnected = true;
      this.failedAttempts = 0;
      this.log("✓ companion linked — the agent will now drive your browser");
      void this.sendStatus();
    };

    ws.onmessage = (ev) => {
      let control: CompanionControl;
      try {
        control = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data)) as CompanionControl;
      } catch {
        return;
      }
      void this.handleControl(control);
    };

    ws.onclose = (ev) => {
      this.ws = null;
      if (this.stopped) return;
      const closeReason = (ev?.reason ?? "").toLowerCase();
      // A newer connection from THIS computer took over (e.g. a fresh
      // `zero browser connect` here superseding this background process). A
      // routine hand-off: exit quietly without alarming the user, and don't
      // reconnect, or the two would evict each other in a loop.
      if (closeReason.includes(SUPERSEDED_REASON)) {
        this.stopped = true;
        this.log("↪ a newer `zero browser connect` on this computer took over the link; exiting this one.");
        void this.engine.stop();
        this.opts.onTakenOver?.();
        return;
      }
      // A deliberate takeover from another computer: yield instead of
      // reconnecting, otherwise both machines evict each other in a loop.
      if (closeReason.includes(REPLACED_REASON)) {
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
