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
import { homedir } from "node:os";
import { join } from "node:path";
import type { BrowserAction, BrowserResult } from "../sdk/browser-protocol.ts";
import { loadPlaywright } from "./playwright-setup.ts";

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
  close(): Promise<void>;
  /** Owning browser, or null for a persistent context on some Playwright versions. */
  browser?(): PwBrowser | null;
  on?(event: string, cb: (...args: any[]) => void): void;
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
  /**
   * When launching, drive a CLEAN throwaway profile (no logins/cookies) instead
   * of the user's real Chrome profile. Default is to use the real profile so the
   * agent inherits the user's existing sessions.
   */
  fresh?: boolean;
  /**
   * Chrome user-data dir to launch against (the persistent profile root that
   * holds cookies/logins). Defaults to the OS-standard Google Chrome location.
   * Ignored over CDP and when `fresh` is set.
   */
  userDataDir?: string;
  /**
   * Name of the profile subdirectory within the user-data dir to load
   * (e.g. "Default", "Profile 1"). Maps to Chrome's `--profile-directory`.
   * Defaults to whatever Chrome picks (usually "Default").
   */
  profileDirectory?: string;
  /** Sink for non-fatal warnings (e.g. channel → bundled fallback). */
  onWarn?: (line: string) => void;
}

/**
 * OS-standard Google Chrome user-data directory (the profile root, NOT a single
 * profile). Chrome loads its "Default" profile from inside this unless
 * `--profile-directory` overrides it.
 */
export function defaultChromeUserDataDir(): string {
  const home = homedir();
  switch (process.platform) {
    case "darwin":
      return join(home, "Library", "Application Support", "Google", "Chrome");
    case "win32":
      return join(
        process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"),
        "Google",
        "Chrome",
        "User Data",
      );
    default:
      return join(home, ".config", "google-chrome");
  }
}

/**
 * Heuristic: does this launch error look like Chrome refusing because the
 * profile is already locked by a running Chrome (the SingletonLock)? Chrome
 * can't share a user-data dir between a live browser and an automation launch.
 */
function looksLikeProfileLock(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    m.includes("singletonlock") ||
    m.includes("processsingleton") ||
    // Chrome's own wording when the user-data dir is held by a running instance:
    // "Opening in existing browser session. This usually means that the profile
    //  is already in use by another instance of Chromium."
    m.includes("opening in existing browser session") ||
    m.includes("already in use") ||
    m.includes("already running") ||
    m.includes("profile appears to be in use") ||
    m.includes("in use by another") ||
    m.includes("being used by another") ||
    m.includes("closed unexpectedly")
  );
}

export class CompanionEngine {
  private browser: PwBrowser | null = null;
  private context: PwBrowserContext | null = null;
  private page: PwPage | null = null;
  /** True when we own a persistent context we launched (vs. an attached CDP one). */
  private ownsContext = false;
  /** Liveness fallback for persistent contexts whose browser() is null. */
  private alive = false;

  constructor(private opts: EngineOptions) {}

  async start(): Promise<void> {
    // Playwright is loaded lazily and auto-installed into ~/.zero on first use.
    const pw = await loadPlaywright((line) => this.opts.onWarn?.(line));
    const chromium = pw.chromium;
    if (this.opts.cdpUrl) {
      // Attach to a Chrome the user already started with remote debugging. We
      // adopt its existing context (and thus its tabs/logins) and must NOT close
      // it on stop — it's the user's own running browser.
      this.browser = await chromium.connectOverCDP(this.opts.cdpUrl);
      const ctxs = this.browser!.contexts();
      this.context = ctxs[0] ?? (await this.browser!.newContext());
      const pages = this.context.pages();
      this.page = pages[0] ?? (await this.context.newPage());
    } else if (this.opts.fresh) {
      // Opt-in clean room: a throwaway profile with no logins/cookies. Useful
      // for isolated automation, but the agent won't have the user's sessions.
      this.browser = await this.launchFresh(chromium, this.opts.channel);
      this.context = await this.browser!.newContext({ viewport: null });
      this.ownsContext = true;
      this.page = await this.context.newPage();
    } else {
      // Default: launch the user's installed Google Chrome against their REAL
      // profile (a persistent context over their on-disk user-data dir), so the
      // agent inherits their existing logins/cookies/sessions. Chrome locks a
      // profile while it's open, so this requires the user's normal Chrome to be
      // fully quit first; launchPersistent() turns that lock into a clear error.
      const userDataDir = this.opts.userDataDir ?? defaultChromeUserDataDir();
      this.context = await this.launchPersistent(chromium, userDataDir);
      this.ownsContext = true;
      this.browser = this.context.browser?.() ?? null;
      const pages = this.context.pages();
      this.page = pages[0] ?? (await this.context.newPage());
    }
    // Track liveness even when browser() is null (persistent contexts on some
    // Playwright versions): flip dead when the context closes.
    this.alive = true;
    this.context?.on?.("close", () => {
      this.alive = false;
    });
  }

  /**
   * Launch a CLEAN headed browser (no profile), preferring the requested
   * channel (installed Google Chrome) and falling back to Playwright's bundled
   * Chromium if that channel isn't available on this machine.
   */
  private async launchFresh(chromium: any, channel?: string): Promise<PwBrowser> {
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

  /**
   * Launch a headed browser bound to a persistent on-disk profile (the user's
   * real Chrome user-data dir), so cookies/logins carry over. Translates a
   * profile-lock failure (Chrome already running) into an actionable error, and
   * falls back to the bundled Chromium if the installed-Chrome channel is
   * unavailable.
   */
  private async launchPersistent(chromium: any, userDataDir: string): Promise<PwBrowserContext> {
    const channel = this.opts.channel;
    const launchOpts: Record<string, any> = {
      headless: false,
      viewport: null,
      args: this.opts.profileDirectory ? [`--profile-directory=${this.opts.profileDirectory}`] : [],
    };
    try {
      return await chromium.launchPersistentContext(userDataDir, { ...launchOpts, ...(channel ? { channel } : {}) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (looksLikeProfileLock(msg)) {
        throw new Error(
          `Could not open Chrome with your profile — it looks like Google Chrome is already running.\n` +
            `Chrome locks a profile while it's open, so the agent can't drive it at the same time.\n` +
            `Fix: quit Google Chrome completely (Cmd-Q / fully exit, not just close the window), then re-run \`zero browser connect\`.\n` +
            `Alternatives: pass \`--fresh\` to use a clean throwaway profile, or \`--cdp <url>\` to attach to a Chrome started with --remote-debugging-port.\n` +
            `(profile dir: ${userDataDir}; underlying error: ${msg})`,
        );
      }
      if (!channel) throw err;
      this.opts.onWarn?.(
        `could not launch installed Chrome (channel "${channel}"): ${msg}; ` +
          `falling back to Playwright's bundled Chromium`,
      );
      return await chromium.launchPersistentContext(userDataDir, launchOpts);
    }
  }

  async stop(): Promise<void> {
    // For a context we launched (persistent or fresh), closing it tears down the
    // browser too. For an attached CDP context we must leave the user's context
    // alone and only drop our connection to the browser.
    if (this.ownsContext) {
      try {
        await this.context?.close();
      } catch {
        // ignore
      }
    }
    try {
      await this.browser?.close();
    } catch {
      // ignore
    }
    this.alive = false;
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  isAlive(): boolean {
    if (this.browser) return this.browser.isConnected();
    return this.alive;
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
