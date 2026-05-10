/**
 * Host-side Playwright browser pool — project-keyed.
 *
 * Replaces the runner-side browser host. One Chromium browser process per
 * server, with one `BrowserContext` + `Page` per Zero project. The agent's
 * CLI calls (`zero browser open|click|fill|...`) flow through the per-turn
 * unix socket into `cli-handlers/browser.ts`, which calls into this pool
 * keyed by `ctx.projectId`.
 *
 * The action logic (a11y-tree snapshot with stable refs, ref-stale recovery,
 * incremental snapshot diff, JPEG-downscaled screenshot, replMode evaluate)
 * is the same protocol the runner used — ported to Playwright's
 * `CDPSession`. The agent-facing surface is unchanged: same ref ids, same
 * BrowserResult shapes.
 *
 * Idle eviction: a project session is closed after `IDLE_TTL_MS` of
 * inactivity. The browser process stays up between sessions; only the
 * context (which holds the page + cookies) is recycled.
 *
 * Frame broadcast: every successful action emits a `frame` event (debounced
 * to once per second per project) carrying a JPEG screenshot. `ws-browser`
 * subscribes and forwards to interested viewers.
 */
import { EventEmitter } from "node:events";
import { addExtra } from "playwright-extra";
import { chromium as rebrowserChromium } from "rebrowser-playwright";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type {
  Browser,
  BrowserContext,
  BrowserType,
  Page,
  CDPSession,
} from "playwright";
import { log } from "@/lib/utils/logger.ts";

// rebrowser-playwright is a drop-in fork that patches the Runtime.Enable CDP
// leak (a major fingerprint tell that stealth alone can't fix). Wrapped via
// playwright-extra so we can apply the stealth plugin on top: navigator.webdriver,
// WebGL vendor, chrome runtime, permissions, plugins, codecs, UA-headless mask, etc.
const chromium = addExtra(rebrowserChromium as unknown as BrowserType);
chromium.use(StealthPlugin());

const browserLog = log.child({ module: "browser-host-pool" });

// ── Public types ──

export type BrowserAction =
  | { type: "navigate"; url: string }
  | { type: "click"; ref: string }
  | { type: "type"; ref: string; text: string; submit?: boolean }
  | { type: "wait"; ms: number }
  | { type: "snapshot"; mode?: "interactive" | "full"; selector?: string }
  | { type: "screenshot" }
  | { type: "evaluate"; script: string; awaitPromise?: boolean; maxChars?: number };

export type BrowserResult =
  | { type: "snapshot"; url: string; title: string; content: string }
  | { type: "screenshot"; url: string; title: string; base64: string }
  | { type: "evaluate"; url: string; title: string; value: unknown; logs?: string[]; error?: string }
  | { type: "done"; url: string; title: string; message?: string; snapshot?: string };

export interface ScreenshotFrame {
  projectId: string;
  base64: string;
  url: string;
  title: string;
  timestamp: number;
}

// ── Internal state ──

interface SnapshotCache {
  prevLines?: string[];
  prevUrl?: string;
  dirty: boolean;
}

interface ProjectSession {
  projectId: string;
  context: BrowserContext;
  page: Page;
  cdp: CDPSession;
  refMap: Map<string, { role: string; name: string; backendNodeId: number }>;
  snapshotCache: SnapshotCache;
  lastUsedAt: number;
  /** Most recent frame broadcast — used to re-seed late WS subscribers. */
  lastFrame: ScreenshotFrame | null;
  /** Serializes actions per session so concurrent calls don't trip over CDP. */
  queue: Promise<unknown>;
}

const IDLE_TTL_MS = 15 * 60 * 1000;
const IDLE_SWEEP_MS = 60 * 1000;
const FRAME_DEBOUNCE_MS = 1_000;
const MAX_SNAPSHOT_LINES = 150;
const INCREMENTAL_THRESHOLD = 0.5;

// ── Pool ──

class HostBrowserPool extends EventEmitter {
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private sessions = new Map<string, ProjectSession>();
  private sweep: NodeJS.Timeout | null = null;
  private stopping = false;
  private lastFrameAt = new Map<string, number>();

  start(): void {
    if (this.sweep) return;
    this.sweep = setInterval(() => this.idleSweep(), IDLE_SWEEP_MS);
    if (typeof this.sweep.unref === "function") this.sweep.unref();
    browserLog.info("host browser pool ready (lazy launch)");
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.sweep) clearInterval(this.sweep);
    this.sweep = null;
    for (const projectId of [...this.sessions.keys()]) {
      await this.closeSession(projectId).catch(() => {});
    }
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
    this.removeAllListeners();
    browserLog.info("host browser pool stopped");
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) return this.browser;
    if (this.launching) return this.launching;
    this.launching = (async () => {
      const t0 = Date.now();
      const headless = process.env.BROWSER_HEADLESS !== "false";
      const args = [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
      ];
      const b = await chromium.launch({ headless, args });
      b.on("disconnected", () => {
        browserLog.warn("chromium disconnected");
        if (this.browser === b) this.browser = null;
        this.sessions.clear();
      });
      this.browser = b;
      browserLog.info("chromium launched", { headless, ms: Date.now() - t0 });
      return b;
    })();
    try {
      return await this.launching;
    } finally {
      this.launching = null;
    }
  }

  private async ensureSession(projectId: string): Promise<ProjectSession> {
    const existing = this.sessions.get(projectId);
    if (existing && !existing.page.isClosed()) {
      existing.lastUsedAt = Date.now();
      return existing;
    }
    const browser = await this.ensureBrowser();
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Page.enable").catch(() => {});
    await cdp.send("DOM.enable").catch(() => {});
    await cdp.send("Accessibility.enable").catch(() => {});

    const session: ProjectSession = {
      projectId,
      context,
      page,
      cdp,
      refMap: new Map(),
      snapshotCache: { dirty: true },
      lastUsedAt: Date.now(),
      lastFrame: null,
      queue: Promise.resolve(),
    };
    this.sessions.set(projectId, session);

    page.on("close", () => {
      if (this.sessions.get(projectId) === session) this.sessions.delete(projectId);
    });

    browserLog.info("session opened", { projectId });
    return session;
  }

  async closeSession(projectId: string): Promise<void> {
    const s = this.sessions.get(projectId);
    if (!s) return;
    this.sessions.delete(projectId);
    this.lastFrameAt.delete(projectId);
    try {
      await s.cdp.detach();
    } catch {}
    try {
      await s.context.close();
    } catch {}
    browserLog.info("session closed", { projectId });
  }

  private idleSweep(): void {
    const now = Date.now();
    for (const [pid, s] of this.sessions) {
      if (now - s.lastUsedAt > IDLE_TTL_MS) {
        browserLog.info("session evicted (idle)", { projectId: pid });
        void this.closeSession(pid);
      }
    }
  }

  /** Returns the most recent frame for a project, if any. */
  lastFrameFor(projectId: string): ScreenshotFrame | null {
    return this.sessions.get(projectId)?.lastFrame ?? null;
  }

  /** True if a session exists for a project. */
  hasSession(projectId: string): boolean {
    return this.sessions.has(projectId);
  }

  /** Drives a single action for a project. Serialized per project. */
  execute(projectId: string, action: BrowserAction): Promise<BrowserResult> {
    return this.runQueued(projectId, () => this.runAction(projectId, action));
  }

  private runQueued<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    // Tail-chain so all calls for one project serialize. Errors don't break the chain.
    const run = async () => fn();
    const sessionPromise = this.ensureSession(projectId);
    const next = sessionPromise.then(async (s) => {
      const prev = s.queue;
      let resolve: (v: unknown) => void;
      const gate = new Promise((r) => (resolve = r));
      s.queue = gate as Promise<unknown>;
      try {
        await prev;
      } catch {
        // swallow — prior caller already saw the error
      }
      try {
        return await run();
      } finally {
        resolve!(undefined);
      }
    });
    return next;
  }

  private async runAction(projectId: string, action: BrowserAction): Promise<BrowserResult> {
    const s = await this.ensureSession(projectId);
    s.lastUsedAt = Date.now();
    try {
      const result = await executeAction(s, action);
      // Best-effort frame broadcast on actions that visibly change the page.
      if (action.type !== "snapshot" && action.type !== "wait") {
        void this.maybeBroadcastFrame(s).catch(() => {});
      }
      return result;
    } catch (err) {
      browserLog.warn("action failed", {
        projectId,
        action: action.type,
        err: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  private async maybeBroadcastFrame(s: ProjectSession): Promise<void> {
    const last = this.lastFrameAt.get(s.projectId) ?? 0;
    if (Date.now() - last < FRAME_DEBOUNCE_MS) return;
    this.lastFrameAt.set(s.projectId, Date.now());
    let base64 = "";
    try {
      const buf = await s.page.screenshot({ type: "jpeg", quality: 60, fullPage: false });
      base64 = buf.toString("base64");
    } catch {
      return;
    }
    let url = "";
    let title = "";
    try {
      url = s.page.url();
      title = await s.page.title();
    } catch {}
    const frame: ScreenshotFrame = {
      projectId: s.projectId,
      base64,
      url,
      title,
      timestamp: Date.now(),
    };
    s.lastFrame = frame;
    this.emit("frame", frame);
  }
}

// ── Action implementation (CDP-backed, ported from runner/lib/browser.ts) ──

function resolveRef(refMap: ProjectSession["refMap"], ref: string): number {
  const entry = refMap.get(ref);
  if (!entry) {
    throw new Error(`Element ref [${ref}] not found. Take a snapshot first to get current refs.`);
  }
  return entry.backendNodeId;
}

async function resolveNode(cdp: CDPSession, backendNodeId: number): Promise<string> {
  const { object } = await cdp.send("DOM.resolveNode", { backendNodeId });
  if (!object?.objectId) {
    throw new Error("Could not resolve node — it may have been removed from the DOM. Take a new snapshot.");
  }
  return object.objectId;
}

async function getNodeCenter(cdp: CDPSession, backendNodeId: number) {
  const objectId = await resolveNode(cdp, backendNodeId);
  const result = await cdp.send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `function() {
      const r = this.getBoundingClientRect();
      return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2, width: r.width, height: r.height });
    }`,
    returnByValue: true,
  });
  await cdp.send("Runtime.releaseObject", { objectId }).catch(() => {});
  return JSON.parse((result as any).result.value);
}

async function clickNode(cdp: CDPSession, backendNodeId: number) {
  const objectId = await resolveNode(cdp, backendNodeId);
  await cdp
    .send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function() { this.scrollIntoViewIfNeeded(); }`,
    })
    .catch(() => {});
  await cdp.send("Runtime.releaseObject", { objectId }).catch(() => {});
  const pos = await getNodeCenter(cdp, backendNodeId);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pos.x, y: pos.y });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
}

async function focusAndType(cdp: CDPSession, backendNodeId: number, text: string) {
  try {
    await cdp.send("DOM.focus", { backendNodeId });
  } catch {
    const pos = await getNodeCenter(cdp, backendNodeId);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pos.x, y: pos.y });
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
  }
  const objectId = await resolveNode(cdp, backendNodeId);
  await cdp.send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `function() {
      if ('value' in this) { this.value = ''; this.dispatchEvent(new Event('input', { bubbles: true })); }
      else if (this.isContentEditable) { this.textContent = ''; this.dispatchEvent(new Event('input', { bubbles: true })); }
    }`,
  });
  await cdp.send("Runtime.releaseObject", { objectId }).catch(() => {});
  await cdp.send("Input.insertText", { text });
}

async function getPageInfo(page: Page): Promise<{ url: string; title: string }> {
  let url = "";
  let title = "";
  try { url = page.url(); } catch {}
  try { title = await page.title(); } catch {}
  return { url, title };
}

async function waitForLoad(page: Page, timeout = 10_000): Promise<void> {
  try {
    await page.waitForLoadState("load", { timeout });
  } catch {}
}

async function waitForNetworkIdle(page: Page, timeout = 5_000): Promise<void> {
  try {
    await page.waitForLoadState("networkidle", { timeout });
  } catch {}
}

function stripRefs(line: string): string {
  return line.replace(/ \[ref=e\d+\]/g, "");
}

async function buildA11ySnapshot(
  cdp: CDPSession,
  options?: { relaxed?: boolean; interactiveOnly?: boolean; selector?: string },
): Promise<{ content: string; truncated?: boolean; refMap: ProjectSession["refMap"] }> {
  const refMap: ProjectSession["refMap"] = new Map();
  let refCounter = 0;
  const relaxed = options?.relaxed ?? false;
  const interactiveOnly = options?.interactiveOnly ?? false;

  let rootBackendNodeId: number | undefined;
  if (options?.selector) {
    try {
      const doc = await cdp.send("DOM.getDocument", { depth: 0 });
      const { nodeId } = await cdp.send("DOM.querySelector", {
        nodeId: (doc as any).root.nodeId,
        selector: options.selector,
      });
      if (nodeId) {
        const { node } = await cdp.send("DOM.describeNode", { nodeId });
        rootBackendNodeId = (node as any).backendNodeId;
      }
    } catch {
      // fall through to full tree
    }
  }

  const ax: any = await cdp.send("Accessibility.getFullAXTree", { depth: 50 });
  const nodes: any[] = ax.nodes;

  const nodeMap = new Map<string, any>();
  const children = new Map<string, string[]>();
  for (const node of nodes) {
    nodeMap.set(node.nodeId, node);
    if (node.parentId) {
      const kids = children.get(node.parentId) ?? [];
      kids.push(node.nodeId);
      children.set(node.parentId, kids);
    }
  }

  let scopeNodeId: string | undefined;
  if (rootBackendNodeId) {
    for (const node of nodes) {
      if (node.backendDOMNodeId === rootBackendNodeId) {
        scopeNodeId = node.nodeId;
        break;
      }
    }
  }

  const skipRoles = new Set([
    "none", "InlineTextBox", "LineBreak",
    "StaticText", "RootWebArea", "ignored",
    ...(relaxed ? [] : ["generic"]),
  ]);
  const interactiveRoles = new Set([
    "button", "link", "textbox", "checkbox", "radio",
    "combobox", "menuitem", "tab", "switch", "slider",
    "searchbox", "spinbutton", "option", "menuitemcheckbox",
    "menuitemradio", "treeitem",
  ]);

  const lines: string[] = [];
  const lineLimit = interactiveOnly ? Infinity : MAX_SNAPSHOT_LINES;
  let truncated = false;

  function renderNode(nodeId: string, depth: number) {
    if (truncated) return;
    const node = nodeMap.get(nodeId);
    if (!node) return;
    const role = node.role?.value ?? "";
    const name = node.name?.value ?? "";
    const backendNodeId = node.backendDOMNodeId;
    if (skipRoles.has(role)) {
      const keepGeneric = role === "generic" && name && backendNodeId;
      if (!keepGeneric) {
        for (const kid of children.get(nodeId) ?? []) renderNode(kid, depth);
        return;
      }
    }
    const isInteractive = interactiveRoles.has(role);
    if (interactiveOnly && !isInteractive) {
      for (const kid of children.get(nodeId) ?? []) renderNode(kid, depth);
      return;
    }
    if (lines.length >= lineLimit) {
      truncated = true;
      return;
    }
    let ref = "";
    if (relaxed) {
      if (backendNodeId) {
        refCounter++;
        const refId = `e${refCounter}`;
        ref = ` [ref=${refId}]`;
        refMap.set(refId, { role, name, backendNodeId });
      }
    } else if (backendNodeId && (isInteractive || name)) {
      refCounter++;
      const refId = `e${refCounter}`;
      ref = ` [ref=${refId}]`;
      refMap.set(refId, { role, name, backendNodeId });
    }
    const nameStr = name ? ` "${name}"` : "";
    if (interactiveOnly) {
      lines.push(`- ${role}${nameStr}${ref}`);
    } else {
      lines.push(`${"  ".repeat(depth)}- ${role}${nameStr}${ref}`);
    }
    if (!interactiveOnly) {
      for (const kid of children.get(nodeId) ?? []) renderNode(kid, depth + 1);
    }
  }

  const startNode = scopeNodeId
    ? nodeMap.get(scopeNodeId)
    : nodes.find((n: any) => !n.parentId || n.role?.value === "RootWebArea");
  if (startNode) {
    if (scopeNodeId) {
      renderNode(scopeNodeId, 0);
    } else {
      for (const kid of children.get(startNode.nodeId) ?? []) renderNode(kid, 0);
    }
  }
  if (truncated) {
    lines.push(`\n[...truncated at ${lineLimit} lines — use snapshot with a CSS selector to see specific sections, e.g. selector: "main", "article", "#content"]`);
  }
  return { content: lines.join("\n"), truncated, refMap };
}

async function takeSnapshot(
  s: ProjectSession,
  opts?: { interactiveOnly?: boolean; selector?: string },
): Promise<string> {
  const interactiveOnly = opts?.interactiveOnly ?? false;
  let snap = await buildA11ySnapshot(s.cdp, { interactiveOnly, selector: opts?.selector });
  s.refMap.clear();
  for (const [k, v] of snap.refMap) s.refMap.set(k, v);
  if (s.refMap.size === 0) {
    snap = await buildA11ySnapshot(s.cdp, {
      relaxed: true,
      interactiveOnly,
      selector: opts?.selector,
    });
    s.refMap.clear();
    for (const [k, v] of snap.refMap) s.refMap.set(k, v);
  }
  let content = snap.content;
  if (!content && s.refMap.size === 0) {
    content = "[No interactive elements found in page accessibility tree. " +
      "Try: snapshot with mode 'full' to see all content, screenshot to see the page visually, " +
      "evaluate to inspect the DOM with JavaScript, or wait and snapshot again if the page is still loading.]";
  }

  // Incremental diff vs cache.
  const currentLines = content.split("\n");
  const currentStripped = currentLines.map(stripRefs);
  const currentUrl = s.page.url();
  if (
    s.snapshotCache.prevLines &&
    s.snapshotCache.prevUrl === currentUrl &&
    !opts?.selector
  ) {
    const prevSet = new Set(s.snapshotCache.prevLines);
    const currSet = new Set(currentStripped);
    const added: string[] = [];
    const removed: string[] = [];
    for (let i = 0; i < currentLines.length; i++) {
      if (!prevSet.has(currentStripped[i]!)) added.push(currentLines[i]!);
    }
    for (const prevLine of s.snapshotCache.prevLines) {
      if (!currSet.has(prevLine)) removed.push(prevLine);
    }
    const unchanged = currentLines.length - added.length;
    const isIncremental = unchanged / Math.max(currentLines.length, 1) >= INCREMENTAL_THRESHOLD;
    if (isIncremental && (added.length > 0 || removed.length > 0)) {
      const parts: string[] = [];
      parts.push(`[Incremental snapshot — ${unchanged} unchanged, ${added.length} added, ${removed.length} removed]`);
      if (added.length > 0) parts.push("", "Added:", ...added);
      if (removed.length > 0) parts.push("", "Removed:", ...removed);
      const interactiveLines = currentLines.filter((_, i) => {
        const line = currentStripped[i]!;
        return /^-?\s*- (button|link|textbox|checkbox|radio|combobox|menuitem|tab|switch|slider|searchbox|spinbutton|option)/.test(line.trimStart());
      });
      if (interactiveLines.length > 0) parts.push("", "Interactive elements:", ...interactiveLines);
      content = parts.join("\n");
    }
  }
  s.snapshotCache.prevLines = currentStripped;
  s.snapshotCache.prevUrl = currentUrl;
  s.snapshotCache.dirty = false;
  return content;
}

async function snapshotIfNavigated(s: ProjectSession, urlBefore: string): Promise<string | undefined> {
  const urlAfter = s.page.url();
  if (urlAfter !== urlBefore) return takeSnapshot(s, { interactiveOnly: true });
  return undefined;
}

function isStaleNodeError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("does not belong to the document") ||
    msg.includes("No node with given id found") ||
    msg.includes("Could not resolve node") ||
    msg.includes("not found — it may have been removed")
  );
}

async function reResolveRef(s: ProjectSession, ref: string): Promise<number> {
  await takeSnapshot(s, { interactiveOnly: true });
  return resolveRef(s.refMap, ref);
}

async function executeAction(s: ProjectSession, action: BrowserAction): Promise<BrowserResult> {
  const { cdp, page } = s;

  switch (action.type) {
    case "navigate": {
      try {
        await page.goto(action.url, { waitUntil: "load", timeout: 30_000 });
      } catch (err) {
        // Surface navigation timeouts as a normal action error.
        throw new Error(`navigate failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      await waitForNetworkIdle(page);
      const info = await getPageInfo(page);
      const snapshot = await takeSnapshot(s, { interactiveOnly: true });
      return { type: "done", ...info, message: `Navigated to ${action.url}`, snapshot };
    }
    case "click": {
      const urlBefore = page.url();
      let nodeId = resolveRef(s.refMap, action.ref);
      try {
        await clickNode(cdp, nodeId);
      } catch (err) {
        if (isStaleNodeError(err)) {
          try {
            nodeId = await reResolveRef(s, action.ref);
            await clickNode(cdp, nodeId);
          } catch {
            throw new Error(`Element [${action.ref}] no longer exists on the page. Take a new snapshot to see current elements.`);
          }
        } else throw err;
      }
      await waitForLoad(page, 5_000);
      s.snapshotCache.dirty = true;
      const info = await getPageInfo(page);
      const snapshot = await snapshotIfNavigated(s, urlBefore);
      return { type: "done", ...info, message: `Clicked [${action.ref}]`, snapshot };
    }
    case "type": {
      const urlBefore = page.url();
      let nodeId = resolveRef(s.refMap, action.ref);
      try {
        await focusAndType(cdp, nodeId, action.text);
      } catch (err) {
        if (isStaleNodeError(err)) {
          try {
            nodeId = await reResolveRef(s, action.ref);
            await focusAndType(cdp, nodeId, action.text);
          } catch {
            throw new Error(`Element [${action.ref}] no longer exists on the page. Take a new snapshot to see current elements.`);
          }
        } else throw err;
      }
      if (action.submit) {
        await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
        await waitForLoad(page, 5_000);
      }
      s.snapshotCache.dirty = true;
      const info = await getPageInfo(page);
      const snapshot = await snapshotIfNavigated(s, urlBefore);
      return { type: "done", ...info, message: `Typed into [${action.ref}]`, snapshot };
    }
    case "wait": {
      await new Promise((r) => setTimeout(r, Math.min(action.ms, 10_000)));
      const info = await getPageInfo(page);
      return { type: "done", ...info, message: `Waited ${action.ms}ms` };
    }
    case "snapshot": {
      const interactiveOnly = action.mode !== "full";
      const content = await takeSnapshot(s, { interactiveOnly, selector: action.selector });
      const info = await getPageInfo(page);
      return { type: "snapshot", ...info, content };
    }
    case "screenshot": {
      const buf = await page.screenshot({ type: "jpeg", quality: 60, fullPage: false });
      // Cap max dimension via re-encode? The viewport is 1280x800, already
      // close to 1024 cap. Skip the CDP-clip rescale — it shaved ~50KB at most.
      const info = await getPageInfo(page);
      return { type: "screenshot", ...info, base64: buf.toString("base64") };
    }
    case "evaluate": {
      const awaitPromise = action.awaitPromise !== false;
      await cdp.send("Runtime.enable").catch(() => {});
      const logs: string[] = [];
      const onConsole = (params: any) => {
        try {
          const level = params?.type ?? "log";
          const args = (params?.args ?? [])
            .map((a: any) => {
              if (a == null) return String(a);
              if ("value" in a) return typeof a.value === "string" ? a.value : JSON.stringify(a.value);
              return a.description ?? a.unserializableValue ?? "";
            })
            .join(" ");
          logs.push(`[${level}] ${args}`);
        } catch {}
      };
      cdp.on("Runtime.consoleAPICalled" as any, onConsole);

      let value: unknown;
      let errorStr: string | undefined;
      try {
        const result: any = await cdp.send("Runtime.evaluate", {
          expression: action.script,
          awaitPromise,
          returnByValue: true,
          userGesture: true,
          replMode: true,
        });
        if (result.exceptionDetails) {
          const ex = result.exceptionDetails;
          const desc = ex.exception?.description ?? ex.text ?? "Unknown error";
          errorStr = `${desc} (line ${ex.lineNumber ?? "?"}:${ex.columnNumber ?? "?"})`;
        } else {
          const r = result.result ?? {};
          value = "value" in r ? r.value : r.description;
        }
      } finally {
        cdp.off("Runtime.consoleAPICalled" as any, onConsole);
      }

      const MAX_VALUE_CHARS = action.maxChars ?? 4_000;
      try {
        const serialized = typeof value === "string" ? value : JSON.stringify(value);
        if (serialized && serialized.length > MAX_VALUE_CHARS) {
          value =
            (typeof value === "string" ? value : serialized).slice(0, MAX_VALUE_CHARS) +
            `\n[...truncated, ${serialized.length - MAX_VALUE_CHARS} chars omitted]`;
        }
      } catch {}

      const info = await getPageInfo(page);
      return {
        type: "evaluate",
        ...info,
        value,
        logs: logs.length > 0 ? logs.slice(0, 200) : undefined,
        error: errorStr,
      };
    }
    default:
      throw new Error(`Unknown action type: ${(action as any).type}`);
  }
}

// ── Singleton ──

let pool: HostBrowserPool | null = null;

export function getBrowserPool(): HostBrowserPool {
  if (!pool) pool = new HostBrowserPool();
  return pool;
}

export function startBrowserPool(): void {
  getBrowserPool().start();
}

export async function stopBrowserPool(): Promise<void> {
  if (!pool) return;
  await pool.stop();
  pool = null;
}

export type { HostBrowserPool };
