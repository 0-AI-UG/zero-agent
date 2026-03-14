/**
 * Raw CDP (Chrome DevTools Protocol) client over WebSocket.
 * Replaces playwright-core — zero external dependencies.
 */
import { enableDomainsStealthy } from "./stealth.ts";

type CdpCallback = (params: any) => void;

export class CdpClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private eventListeners = new Map<string, CdpCallback[]>();
  private _ready: Promise<void>;
  private _resolveReady!: () => void;
  private _onClose?: () => void;
  private _closed = false;

  constructor(private wsUrl: string) {
    this._ready = new Promise((r) => (this._resolveReady = r));
  }

  /** Register a callback for when the CDP connection closes (Chrome crash/quit). */
  set onClose(cb: () => void) {
    this._onClose = cb;
  }

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN && !this._closed;
  }

  async connect(): Promise<void> {
    this._closed = false;
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);

      this.ws.onopen = () => {
        this._resolveReady();
        resolve();
      };

      this.ws.onerror = (e) => {
        reject(new Error(`CDP WebSocket error: ${(e as ErrorEvent).message ?? "unknown"}`));
      };

      this.ws.onclose = () => {
        this._closed = true;
        // Reject all pending
        for (const [, p] of this.pending) {
          p.reject(new Error("CDP connection closed"));
        }
        this.pending.clear();
        this._onClose?.();
      };

      this.ws.onmessage = (event) => {
        const data = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString());

        // Response to a command
        if (data.id !== undefined) {
          const p = this.pending.get(data.id);
          if (p) {
            this.pending.delete(data.id);
            if (data.error) {
              p.reject(new Error(`CDP error: ${data.error.message}`));
            } else {
              p.resolve(data.result ?? {});
            }
          }
          return;
        }

        // Event
        if (data.method) {
          const listeners = this.eventListeners.get(data.method);
          if (listeners) {
            for (const cb of listeners) cb(data.params);
          }
        }
      };
    });
  }

  async send(method: string, params: Record<string, any> = {}): Promise<any> {
    await this._ready;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("CDP not connected");
    }

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, 30_000);

      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });

      this.ws!.send(JSON.stringify({ id, method, params }));
    });
  }

  on(event: string, callback: CdpCallback) {
    const list = this.eventListeners.get(event) ?? [];
    list.push(callback);
    this.eventListeners.set(event, list);
  }

  close() {
    this.ws?.close();
  }
}

/**
 * Connect to a Chrome page target via CDP.
 * 1. List targets via HTTP
 * 2. Find first "page" target
 * 3. Connect via WebSocket to that target's debugger URL
 */
export async function connectToPage(cdpPort: number): Promise<{ cdp: CdpClient; targetId: string }> {
  // Get list of targets
  const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
  const targets = (await res.json()) as Array<{
    id: string;
    type: string;
    url: string;
    title: string;
    webSocketDebuggerUrl: string;
  }>;

  // Find a page target (prefer non-blank)
  let target = targets.find((t) => t.type === "page" && !t.url.startsWith("chrome://"));
  if (!target) target = targets.find((t) => t.type === "page");

  if (!target) {
    // Create a new tab
    const newTab = await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: "PUT" });
    target = (await newTab.json()) as (typeof targets)[0];
  }

  const cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.connect();

  // Enable required domains with stealth measures
  await enableDomainsStealthy(cdp);

  return { cdp, targetId: target.id };
}

/**
 * Extract CDP port from a ws:// or http:// URL
 */
export function extractPort(url: string): number {
  const match = url.match(/:(\d+)/);
  if (!match) throw new Error(`Cannot extract port from: ${url}`);
  return parseInt(match[1]!, 10);
}
