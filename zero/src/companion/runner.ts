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
}

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

    ws.onclose = () => {
      this.ws = null;
      if (this.stopped) return;
      this.log(`link dropped; reconnecting in ${Math.round(this.backoff / 1000)}s…`);
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
