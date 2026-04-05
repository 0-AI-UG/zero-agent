/**
 * Raw CDP (Chrome DevTools Protocol) client over WebSocket.
 */
import { enableDomainsStealthy } from "./stealth.ts";
import { deferAsync } from "./deferred.ts";
import { log } from "./logger.ts";

const cdpLog = log.child({ module: "cdp" });

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

  set onClose(cb: () => void) {
    this._onClose = cb;
  }

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN && !this._closed;
  }

  async connect(): Promise<void> {
    this._closed = false;
    cdpLog.info("connecting", { url: this.wsUrl });
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);

      this.ws.onopen = () => {
        cdpLog.info("connected", { url: this.wsUrl });
        this._resolveReady();
        resolve();
      };

      this.ws.onerror = (e) => {
        cdpLog.error("connection error", { url: this.wsUrl, error: (e as ErrorEvent).message ?? "unknown" });
        reject(new Error(`CDP WebSocket error: ${(e as ErrorEvent).message ?? "unknown"}`));
      };

      this.ws.onclose = () => {
        this._closed = true;
        cdpLog.info("connection closed", { url: this.wsUrl, pendingCommands: this.pending.size });
        for (const [, p] of this.pending) {
          p.reject(new Error("CDP connection closed"));
        }
        this.pending.clear();
        this._onClose?.();
      };

      this.ws.onmessage = (event) => {
        const data = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString());

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

        if (data.method) {
          const listeners = this.eventListeners.get(data.method);
          if (listeners) {
            for (const cb of listeners) cb(data.params);
          }
        }
      };
    });
  }

  async send(method: string, params: Record<string, any> = {}, timeout = 10_000): Promise<any> {
    await this._ready;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("CDP not connected");
    }

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        cdpLog.warn("command timed out", { method, id, timeoutMs: timeout, pendingCommands: this.pending.size });
        reject(new Error(`CDP command timed out: ${method}`));
      }, timeout);

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

  off(event: string, callback: CdpCallback) {
    const list = this.eventListeners.get(event);
    if (!list) return;
    const idx = list.indexOf(callback);
    if (idx !== -1) list.splice(idx, 1);
  }

  close() {
    this.ws?.close();
  }
}

export async function connectToPage(cdpHost: string, cdpPort: number): Promise<{ cdp: CdpClient; targetId: string }> {
  const res = await deferAsync(() => fetch(`http://${cdpHost}:${cdpPort}/json/list`));
  const targets = (await res.json()) as Array<{
    id: string;
    type: string;
    url: string;
    title: string;
    webSocketDebuggerUrl: string;
  }>;

  let target = targets.find((t) => t.type === "page" && !t.url.startsWith("chrome://"));
  if (!target) target = targets.find((t) => t.type === "page");

  if (!target) {
    const newTab = await deferAsync(() => fetch(`http://${cdpHost}:${cdpPort}/json/new?about:blank`, { method: "PUT" }));
    target = (await newTab.json()) as (typeof targets)[0];
  }

  const wsUrl = target.webSocketDebuggerUrl.replace(/127\.0\.0\.1|localhost/, cdpHost);

  const cdp = new CdpClient(wsUrl);
  await cdp.connect();

  await enableDomainsStealthy(cdp);

  return { cdp, targetId: target.id };
}
