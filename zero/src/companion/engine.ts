/**
 * Local browser action engine for the companion. Runs on the USER's machine
 * and drives their real Chrome via Playwright, implementing the same
 * BrowserAction → BrowserResult contract the server's host-pool implements for
 * the container browser. The agent can't tell the two apart.
 *
 * Refs: `snapshot` tags interactive elements with a `data-zero-ref="eN"`
 * attribute and returns an indented accessibility-ish outline citing those
 * refs. `click`/`type` then resolve a ref via that attribute selector, so refs
 * stay valid across calls without server-side state — as long as the page
 * hasn't been replaced (in which case the agent re-snapshots, exactly as with
 * the container browser).
 *
 * Playwright is imported lazily so the in-container `zero` CLI (which never
 * runs the companion) doesn't need it installed.
 */
import type { BrowserAction, BrowserResult } from "../sdk/browser-protocol.ts";

// Minimal structural types so we don't hard-depend on Playwright's types at
// build time (it's an optional dependency).
interface PwPage {
  goto(url: string, opts?: any): Promise<any>;
  url(): string;
  title(): Promise<string>;
  waitForTimeout(ms: number): Promise<void>;
  waitForLoadState(state?: string, opts?: any): Promise<void>;
  screenshot(opts?: any): Promise<Buffer>;
  evaluate<T = any>(fn: any, arg?: any): Promise<T>;
  click(selector: string, opts?: any): Promise<void>;
  fill(selector: string, value: string, opts?: any): Promise<void>;
  press(selector: string, key: string, opts?: any): Promise<void>;
  $(selector: string): Promise<any>;
}

interface PwBrowserContext {
  pages(): PwPage[];
  newPage(): Promise<PwPage>;
}

interface PwBrowser {
  contexts(): PwBrowserContext[];
  newContext(opts?: any): Promise<PwBrowserContext>;
  isConnected(): boolean;
  close(): Promise<void>;
}

export interface EngineOptions {
  /** CDP endpoint of an already-running Chrome (e.g. http://127.0.0.1:9222). */
  cdpUrl?: string;
  /** Launch a fresh headed Chrome instead of attaching to a running one. */
  launch?: boolean;
  /**
   * Playwright browser channel to use when launching (not over CDP).
   * "chrome" launches the user's installed Google Chrome; `undefined` uses
   * Playwright's bundled "Chrome for Testing" build. Defaults to "chrome".
   */
  channel?: string;
  /** Sink for non-fatal warnings (e.g. channel → bundled fallback). */
  onWarn?: (line: string) => void;
}

export class CompanionEngine {
  private browser: PwBrowser | null = null;
  private context: PwBrowserContext | null = null;
  private page: PwPage | null = null;

  constructor(private opts: EngineOptions) {}

  private async loadPlaywright(): Promise<any> {
    try {
      return await import("playwright");
    } catch {
      throw new Error(
        "Playwright is required to connect your local browser. Install it with `npm i -g playwright` (or `npx playwright install chromium`).",
      );
    }
  }

  async start(): Promise<void> {
    const pw = await this.loadPlaywright();
    const chromium = pw.chromium;
    if (this.opts.cdpUrl) {
      this.browser = await chromium.connectOverCDP(this.opts.cdpUrl);
      const ctxs = this.browser!.contexts();
      this.context = ctxs[0] ?? (await this.browser!.newContext());
      const pages = this.context.pages();
      this.page = pages[0] ?? (await this.context.newPage());
    } else {
      // Launch a visible browser the user can watch and interact with. By
      // default this is their installed Google Chrome (channel "chrome") rather
      // than Playwright's bundled "Chrome for Testing" build, so it's the real
      // browser binary they're used to. Note: a fresh launch still gets a clean
      // automation profile — to reuse existing logins/tabs, attach over CDP.
      this.browser = await this.launchHeaded(chromium, this.opts.channel);
      this.context = await this.browser!.newContext({ viewport: null });
      this.page = await this.context.newPage();
    }
  }

  /**
   * Launch a headed browser, preferring the requested channel (e.g. installed
   * Google Chrome) and falling back to Playwright's bundled Chromium if that
   * channel isn't available on this machine.
   */
  private async launchHeaded(chromium: any, channel?: string): Promise<PwBrowser> {
    try {
      return await chromium.launch({ headless: false, ...(channel ? { channel } : {}) });
    } catch (err) {
      if (!channel) throw err;
      this.opts.onWarn?.(
        `could not launch installed Chrome (channel "${channel}"): ${err instanceof Error ? err.message : String(err)}; ` +
          `falling back to Playwright's bundled Chromium`,
      );
      return await chromium.launch({ headless: false });
    }
  }

  async stop(): Promise<void> {
    try {
      await this.browser?.close();
    } catch {
      // ignore
    }
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  isAlive(): boolean {
    return !!this.browser && this.browser.isConnected();
  }

  async capabilities(): Promise<{ dockerInstalled: boolean; dockerRunning: boolean; chromeAvailable: boolean }> {
    return {
      dockerInstalled: false,
      dockerRunning: false,
      chromeAvailable: this.isAlive(),
    };
  }

  private requirePage(): PwPage {
    if (!this.page) throw new Error("Companion browser is not started");
    return this.page;
  }

  async execute(action: BrowserAction): Promise<BrowserResult> {
    const page = this.requirePage();
    switch (action.type) {
      case "navigate": {
        await page.goto(action.url, { waitUntil: "load", timeout: 30_000 }).catch(() => {});
        await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
        return this.done(page, `navigated to ${action.url}`);
      }
      case "click": {
        await page.click(refSelector(action.ref), { timeout: 10_000 });
        await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
        return this.done(page, `clicked ${action.ref}`);
      }
      case "type": {
        const sel = refSelector(action.ref);
        await page.fill(sel, action.text, { timeout: 10_000 });
        if (action.submit) {
          await page.press(sel, "Enter").catch(() => {});
          await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
        }
        return this.done(page, `typed into ${action.ref}`);
      }
      case "wait": {
        await page.waitForTimeout(Math.min(action.ms, 30_000));
        return this.done(page, `waited ${action.ms}ms`);
      }
      case "snapshot": {
        const content = await this.snapshot(page, action.selector);
        const { url, title } = await this.pageInfo(page);
        return { type: "snapshot", url, title, content };
      }
      case "screenshot": {
        const buf = await page.screenshot({ type: "jpeg", quality: 60, fullPage: false });
        const { url, title } = await this.pageInfo(page);
        return { type: "screenshot", url, title, base64: Buffer.from(buf).toString("base64") };
      }
      case "evaluate": {
        const { url, title } = await this.pageInfo(page);
        try {
          const value = await page.evaluate(
            (src: string) => {
              // eslint-disable-next-line no-eval
              const r = (0, eval)(src);
              return r;
            },
            action.script,
          );
          const trimmed = clampValue(value, action.maxChars ?? 10_000);
          return { type: "evaluate", url, title, value: trimmed };
        } catch (err) {
          return { type: "evaluate", url, title, value: null, error: err instanceof Error ? err.message : String(err) };
        }
      }
      default:
        // Unsupported protocol actions (tabs/select/hover/etc.) — report cleanly.
        return this.done(page, `unsupported action: ${(action as any).type}`);
    }
  }

  private async pageInfo(page: PwPage): Promise<{ url: string; title: string }> {
    let url = "";
    let title = "";
    try { url = page.url(); } catch { /* ignore */ }
    try { title = await page.title(); } catch { /* ignore */ }
    return { url, title };
  }

  private async done(page: PwPage, message: string): Promise<BrowserResult> {
    const { url, title } = await this.pageInfo(page);
    return { type: "done", url, title, message };
  }

  /**
   * Tag interactive elements with data-zero-ref and return an indented
   * outline. Runs entirely in-page so it works against any site.
   */
  private async snapshot(page: PwPage, selector?: string): Promise<string> {
    return page.evaluate((rootSelector: string | undefined) => {
      const root: Element = (rootSelector ? document.querySelector(rootSelector) : null) ?? document.body;
      const INTERACTIVE = new Set(["A", "BUTTON", "INPUT", "TEXTAREA", "SELECT"]);
      let counter = 0;
      const lines: string[] = [];

      function label(el: Element): string {
        const aria = el.getAttribute("aria-label");
        if (aria) return aria.trim();
        const el2 = el as HTMLElement;
        const text = (el2.innerText || el2.textContent || "").trim().replace(/\s+/g, " ");
        if (text) return text.slice(0, 80);
        const placeholder = el.getAttribute("placeholder");
        if (placeholder) return placeholder.trim();
        const name = el.getAttribute("name");
        if (name) return name.trim();
        return "";
      }

      function role(el: Element): string {
        const r = el.getAttribute("role");
        if (r) return r;
        const tag = el.tagName.toLowerCase();
        if (tag === "a") return "link";
        if (tag === "button") return "button";
        if (tag === "input") return `input:${(el as HTMLInputElement).type || "text"}`;
        if (tag === "textarea") return "textbox";
        if (tag === "select") return "combobox";
        return tag;
      }

      function isVisible(el: Element): boolean {
        const rect = (el as HTMLElement).getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return false;
        const style = getComputedStyle(el as HTMLElement);
        return style.visibility !== "hidden" && style.display !== "none";
      }

      function walk(node: Element, depth: number): void {
        if (depth > 25) return;
        for (const child of Array.from(node.children)) {
          const tag = child.tagName;
          const clickable = INTERACTIVE.has(tag) || child.hasAttribute("onclick") || child.getAttribute("role") === "button";
          if (clickable && isVisible(child)) {
            const ref = `e${++counter}`;
            child.setAttribute("data-zero-ref", ref);
            const text = label(child);
            lines.push(`${"  ".repeat(Math.min(depth, 8))}${role(child)} "${text}" [ref=${ref}]`);
          }
          walk(child, depth + 1);
        }
      }

      walk(root, 0);
      if (lines.length === 0) {
        const t = (document.body.innerText || "").trim().replace(/\s+/g, " ").slice(0, 2000);
        return `(no interactive elements found)\n${t}`;
      }
      return lines.slice(0, 200).join("\n");
    }, selector);
  }
}

function refSelector(ref: string): string {
  return `[data-zero-ref="${ref}"]`;
}

function clampValue(value: unknown, maxChars: number): unknown {
  if (typeof value === "string") return value.length > maxChars ? value.slice(0, maxChars) + "…" : value;
  try {
    const json = JSON.stringify(value);
    if (json && json.length > maxChars) return JSON.parse(json.slice(0, maxChars));
    return value;
  } catch {
    return String(value).slice(0, maxChars);
  }
}
