/**
 * Zero Companion — MV3 service worker.
 *
 * This is the laptop end of the browser-control link. Instead of Playwright
 * launching and locking the user's Chrome profile, the agent now drives the
 * user's REAL, already-open tab from inside Chrome via `chrome.debugger`
 * (which is the Chrome DevTools Protocol — the exact API the server's headless
 * pool uses). Nothing is launched or locked, so the whole class of
 * profile-lock / keychain-mock / flag-fighting failures disappears.
 *
 * Wiring: the `zero browser connect` CLI runs a localhost WebSocket bridge and
 * writes `bridge.json` (port + one-time secret) into this extension's own
 * directory. We read it, connect to `ws://127.0.0.1:<port>`, prove the secret,
 * and then execute `{type:"command", id, action}` frames against the active
 * tab, replying `{type:"response", id, result|error}`. The action/result
 * shapes are byte-identical to `server/lib/browser/protocol.ts`, so the server
 * and agent can't tell this apart from the headless browser.
 *
 * The CDP action logic below is ported from `server/lib/browser/host-pool.ts`
 * — same a11y-tree snapshot with stable `[ref=eN]` ids, same ref-stale
 * recovery, same incremental diff, same replMode evaluate with console
 * capture. `cdp.send(method, params)` became `sendCmd(tabId, method, params)`.
 */

// chrome.* is provided by the extension runtime; type it loosely so the
// extension builds without @types/chrome as a dependency.
declare const chrome: any;

// ── Bridge link constants ──

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 15_000;
/**
 * Secondary wake: if the worker is ever killed while the bridge is down, this
 * alarm revives it to retry connecting. The PRIMARY keepalive is the bridge's
 * 20s ping (an incoming WS message keeps the worker warm in Chrome 116+).
 * Chrome clamps alarm periods to a 30s (0.5 min) minimum.
 */
const KEEPALIVE_ALARM = "zero-keepalive";
const KEEPALIVE_PERIOD_MIN = 0.5;

const MAX_SNAPSHOT_LINES = 150;
const INCREMENTAL_THRESHOLD = 0.5;

// ── Bridge config (written by the CLI into this extension's dir) ──

interface BridgeConfig {
  port: number;
  secret: string;
}

async function readBridgeConfig(): Promise<BridgeConfig | null> {
  try {
    // Always read fresh from disk: the CLI rewrites port/secret each run, and
    // unpacked extensions are served live from disk so no-store sees updates.
    const res = await fetch(chrome.runtime.getURL("bridge.json"), { cache: "no-store" });
    if (!res.ok) return null;
    const cfg = await res.json();
    if (typeof cfg?.port === "number" && typeof cfg?.secret === "string") return cfg;
    return null;
  } catch {
    return null;
  }
}

// ── Per-tab CDP driver ──

interface RefEntry {
  role: string;
  name: string;
  backendNodeId: number;
}

interface SnapshotCache {
  prevLines?: string[];
  prevUrl?: string;
}

/**
 * Wraps a single attached tab. Holds the same per-page state the host-pool's
 * ProjectSession held (refMap, snapshotCache) plus the console buffer and
 * one-shot CDP event waiters this implementation needs.
 */
class TabDriver {
  refMap = new Map<string, RefEntry>();
  snapshotCache: SnapshotCache = {};
  /** Console lines captured during the current evaluate(). */
  consoleLogs: string[] = [];
  /** One-shot resolvers keyed by CDP event method (e.g. Page.loadEventFired). */
  private waiters = new Map<string, Array<() => void>>();

  constructor(public tabId: number) {}

  send(method: string, params?: Record<string, unknown>): Promise<any> {
    return chrome.debugger.sendCommand({ tabId: this.tabId }, method, params ?? {});
  }

  /** Dispatched by the global onEvent listener for this tab. */
  onEvent(method: string, params: any): void {
    if (method === "Runtime.consoleAPICalled") {
      try {
        const level = params?.type ?? "log";
        const args = (params?.args ?? [])
          .map((a: any) => {
            if (a == null) return String(a);
            if ("value" in a) return typeof a.value === "string" ? a.value : JSON.stringify(a.value);
            return a.description ?? a.unserializableValue ?? "";
          })
          .join(" ");
        this.consoleLogs.push(`[${level}] ${args}`);
      } catch {
        /* ignore */
      }
      return;
    }
    const list = this.waiters.get(method);
    if (list) {
      this.waiters.delete(method);
      for (const fn of list) fn();
    }
  }

  /** Resolve on the next occurrence of a CDP event, or after `timeout` ms. Never rejects. */
  once(method: string, timeout: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const list = this.waiters.get(method) ?? [];
      let done = false;
      const fire = () => {
        if (done) return;
        done = true;
        resolve();
      };
      list.push(fire);
      this.waiters.set(method, list);
      setTimeout(fire, timeout);
    });
  }

  async info(): Promise<{ url: string; title: string }> {
    try {
      const tab = await chrome.tabs.get(this.tabId);
      return { url: tab?.url ?? "", title: tab?.title ?? "" };
    } catch {
      return { url: "", title: "" };
    }
  }
}

// ── CDP action helpers (ported from host-pool.ts) ──

function resolveRef(drv: TabDriver, ref: string): number {
  const entry = drv.refMap.get(ref);
  if (!entry) {
    throw new Error(`Element ref [${ref}] not found. Take a snapshot first to get current refs.`);
  }
  return entry.backendNodeId;
}

async function resolveNode(drv: TabDriver, backendNodeId: number): Promise<string> {
  const { object } = await drv.send("DOM.resolveNode", { backendNodeId });
  if (!object?.objectId) {
    throw new Error("Could not resolve node — it may have been removed from the DOM. Take a new snapshot.");
  }
  return object.objectId;
}

async function getNodeCenter(drv: TabDriver, backendNodeId: number) {
  const objectId = await resolveNode(drv, backendNodeId);
  const result = await drv.send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `function() {
      const r = this.getBoundingClientRect();
      return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2, width: r.width, height: r.height });
    }`,
    returnByValue: true,
  });
  await drv.send("Runtime.releaseObject", { objectId }).catch(() => {});
  return JSON.parse(result.result.value);
}

async function clickNode(drv: TabDriver, backendNodeId: number) {
  const objectId = await resolveNode(drv, backendNodeId);
  await drv
    .send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function() { this.scrollIntoViewIfNeeded(); }`,
    })
    .catch(() => {});
  await drv.send("Runtime.releaseObject", { objectId }).catch(() => {});
  const pos = await getNodeCenter(drv, backendNodeId);
  await drv.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pos.x, y: pos.y });
  await drv.send("Input.dispatchMouseEvent", { type: "mousePressed", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
  await drv.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
}

async function hoverNode(drv: TabDriver, backendNodeId: number) {
  const pos = await getNodeCenter(drv, backendNodeId);
  await drv.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pos.x, y: pos.y });
}

async function focusAndType(drv: TabDriver, backendNodeId: number, text: string) {
  try {
    await drv.send("DOM.focus", { backendNodeId });
  } catch {
    const pos = await getNodeCenter(drv, backendNodeId);
    await drv.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pos.x, y: pos.y });
    await drv.send("Input.dispatchMouseEvent", { type: "mousePressed", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
    await drv.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
  }
  const objectId = await resolveNode(drv, backendNodeId);
  await drv.send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `function() {
      if ('value' in this) { this.value = ''; this.dispatchEvent(new Event('input', { bubbles: true })); }
      else if (this.isContentEditable) { this.textContent = ''; this.dispatchEvent(new Event('input', { bubbles: true })); }
    }`,
  });
  await drv.send("Runtime.releaseObject", { objectId }).catch(() => {});
  await drv.send("Input.insertText", { text });
}

function stripRefs(line: string): string {
  return line.replace(/ \[ref=e\d+\]/g, "");
}

async function buildA11ySnapshot(
  drv: TabDriver,
  options?: { relaxed?: boolean; interactiveOnly?: boolean; selector?: string },
): Promise<{ content: string; truncated?: boolean; refMap: Map<string, RefEntry> }> {
  const refMap = new Map<string, RefEntry>();
  let refCounter = 0;
  const relaxed = options?.relaxed ?? false;
  const interactiveOnly = options?.interactiveOnly ?? false;

  let rootBackendNodeId: number | undefined;
  if (options?.selector) {
    try {
      const doc = await drv.send("DOM.getDocument", { depth: 0 });
      const { nodeId } = await drv.send("DOM.querySelector", {
        nodeId: doc.root.nodeId,
        selector: options.selector,
      });
      if (nodeId) {
        const { node } = await drv.send("DOM.describeNode", { nodeId });
        rootBackendNodeId = node.backendNodeId;
      }
    } catch {
      // fall through to full tree
    }
  }

  const ax: any = await drv.send("Accessibility.getFullAXTree", { depth: 50 });
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
  drv: TabDriver,
  opts?: { interactiveOnly?: boolean; selector?: string },
): Promise<string> {
  const interactiveOnly = opts?.interactiveOnly ?? false;
  let snap = await buildA11ySnapshot(drv, { interactiveOnly, selector: opts?.selector });
  drv.refMap.clear();
  for (const [k, v] of snap.refMap) drv.refMap.set(k, v);
  if (drv.refMap.size === 0) {
    snap = await buildA11ySnapshot(drv, {
      relaxed: true,
      interactiveOnly,
      selector: opts?.selector,
    });
    drv.refMap.clear();
    for (const [k, v] of snap.refMap) drv.refMap.set(k, v);
  }
  let content = snap.content;
  if (!content && drv.refMap.size === 0) {
    content = "[No interactive elements found in page accessibility tree. " +
      "Try: snapshot with mode 'full' to see all content, screenshot to see the page visually, " +
      "evaluate to inspect the DOM with JavaScript, or wait and snapshot again if the page is still loading.]";
  }

  // Incremental diff vs cache.
  const currentLines = content.split("\n");
  const currentStripped = currentLines.map(stripRefs);
  const currentUrl = (await drv.info()).url;
  if (
    drv.snapshotCache.prevLines &&
    drv.snapshotCache.prevUrl === currentUrl &&
    !opts?.selector
  ) {
    const prevSet = new Set(drv.snapshotCache.prevLines);
    const currSet = new Set(currentStripped);
    const added: string[] = [];
    const removed: string[] = [];
    for (let i = 0; i < currentLines.length; i++) {
      if (!prevSet.has(currentStripped[i]!)) added.push(currentLines[i]!);
    }
    for (const prevLine of drv.snapshotCache.prevLines) {
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
  drv.snapshotCache.prevLines = currentStripped;
  drv.snapshotCache.prevUrl = currentUrl;
  return content;
}

async function snapshotIfNavigated(drv: TabDriver, urlBefore: string): Promise<string | undefined> {
  const urlAfter = (await drv.info()).url;
  if (urlAfter !== urlBefore) return takeSnapshot(drv, { interactiveOnly: true });
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

async function reResolveRef(drv: TabDriver, ref: string): Promise<number> {
  await takeSnapshot(drv, { interactiveOnly: true });
  return resolveRef(drv, ref);
}

// ── Action dispatch ──

type BrowserAction = { type: string; [k: string]: any };
type BrowserResult = Record<string, any>;

async function executeAction(drv: TabDriver, action: BrowserAction): Promise<BrowserResult> {
  switch (action.type) {
    case "navigate": {
      const loaded = drv.once("Page.loadEventFired", 30_000);
      try {
        await drv.send("Page.navigate", { url: action.url });
      } catch (err) {
        throw new Error(`navigate failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      await loaded;
      await new Promise((r) => setTimeout(r, 500)); // settle (≈ networkidle)
      const info = await drv.info();
      const snapshot = await takeSnapshot(drv, { interactiveOnly: true });
      return { type: "done", ...info, message: `Navigated to ${action.url}`, snapshot };
    }
    case "click": {
      const urlBefore = (await drv.info()).url;
      let nodeId = resolveRef(drv, action.ref);
      try {
        await clickNode(drv, nodeId);
      } catch (err) {
        if (isStaleNodeError(err)) {
          try {
            nodeId = await reResolveRef(drv, action.ref);
            await clickNode(drv, nodeId);
          } catch {
            throw new Error(`Element [${action.ref}] no longer exists on the page. Take a new snapshot to see current elements.`);
          }
        } else throw err;
      }
      await drv.once("Page.loadEventFired", 5_000);
      const info = await drv.info();
      const snapshot = await snapshotIfNavigated(drv, urlBefore);
      return { type: "done", ...info, message: `Clicked [${action.ref}]`, snapshot };
    }
    case "type": {
      const urlBefore = (await drv.info()).url;
      let nodeId = resolveRef(drv, action.ref);
      try {
        await focusAndType(drv, nodeId, action.text);
      } catch (err) {
        if (isStaleNodeError(err)) {
          try {
            nodeId = await reResolveRef(drv, action.ref);
            await focusAndType(drv, nodeId, action.text);
          } catch {
            throw new Error(`Element [${action.ref}] no longer exists on the page. Take a new snapshot to see current elements.`);
          }
        } else throw err;
      }
      if (action.submit) {
        await drv.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
        await drv.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
        await drv.once("Page.loadEventFired", 5_000);
      }
      const info = await drv.info();
      const snapshot = await snapshotIfNavigated(drv, urlBefore);
      return { type: "done", ...info, message: `Typed into [${action.ref}]`, snapshot };
    }
    case "select": {
      // Set <select>.value and fire change. Not part of host-pool today; kept
      // simple. Returns done either way so the agent can re-snapshot.
      const nodeId = resolveRef(drv, action.ref);
      const objectId = await resolveNode(drv, nodeId);
      await drv.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: `function(v) { this.value = v; this.dispatchEvent(new Event('change', { bubbles: true })); }`,
        arguments: [{ value: action.value }],
      });
      await drv.send("Runtime.releaseObject", { objectId }).catch(() => {});
      const info = await drv.info();
      return { type: "done", ...info, message: `Selected ${action.value} in [${action.ref}]` };
    }
    case "hover": {
      const nodeId = resolveRef(drv, action.ref);
      await hoverNode(drv, nodeId);
      const info = await drv.info();
      return { type: "done", ...info, message: `Hovered [${action.ref}]` };
    }
    case "scroll": {
      const amount = action.amount ?? 600;
      const dy = action.direction === "up" ? -amount : amount;
      await drv.send("Runtime.evaluate", { expression: `window.scrollBy(0, ${dy})` });
      const info = await drv.info();
      return { type: "done", ...info, message: `Scrolled ${action.direction}` };
    }
    case "back": {
      await navigateHistory(drv, -1);
      const info = await drv.info();
      return { type: "done", ...info, message: "Went back" };
    }
    case "forward": {
      await navigateHistory(drv, 1);
      const info = await drv.info();
      return { type: "done", ...info, message: "Went forward" };
    }
    case "reload": {
      const loaded = drv.once("Page.loadEventFired", 30_000);
      await drv.send("Page.reload", {});
      await loaded;
      const info = await drv.info();
      return { type: "done", ...info, message: "Reloaded" };
    }
    case "wait": {
      await new Promise((r) => setTimeout(r, Math.min(action.ms, 10_000)));
      const info = await drv.info();
      return { type: "done", ...info, message: `Waited ${action.ms}ms` };
    }
    case "snapshot": {
      const interactiveOnly = action.mode !== "full";
      const content = await takeSnapshot(drv, { interactiveOnly, selector: action.selector });
      const info = await drv.info();
      return { type: "snapshot", ...info, content };
    }
    case "screenshot": {
      const { data } = await drv.send("Page.captureScreenshot", { format: "jpeg", quality: 60 });
      const info = await drv.info();
      return { type: "screenshot", ...info, base64: data };
    }
    case "evaluate": {
      const awaitPromise = action.awaitPromise !== false;
      drv.consoleLogs = [];
      let value: unknown;
      let errorStr: string | undefined;
      const result: any = await drv.send("Runtime.evaluate", {
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

      const MAX_VALUE_CHARS = action.maxChars ?? 4_000;
      try {
        const serialized = typeof value === "string" ? value : JSON.stringify(value);
        if (serialized && serialized.length > MAX_VALUE_CHARS) {
          value =
            (typeof value === "string" ? value : serialized).slice(0, MAX_VALUE_CHARS) +
            `\n[...truncated, ${serialized.length - MAX_VALUE_CHARS} chars omitted]`;
        }
      } catch {
        /* ignore */
      }

      const logs = drv.consoleLogs.slice(0, 200);
      drv.consoleLogs = [];
      const info = await drv.info();
      return { type: "evaluate", ...info, value, logs: logs.length > 0 ? logs : undefined, error: errorStr };
    }
    case "tabs": {
      const tabs = await chrome.tabs.query({ lastFocusedWindow: true });
      return {
        type: "tabs",
        tabs: tabs.map((t: any, i: number) => ({ index: i, url: t.url ?? "", title: t.title ?? "", active: !!t.active })),
      };
    }
    default: {
      // switchTab / closeTab and any future actions: report cleanly (parity
      // with the previous companion engine) so the agent can adapt.
      const info = await drv.info();
      return { type: "done", ...info, message: `unsupported action: ${action.type}` };
    }
  }
}

/** Navigate the active tab's history by delta using CDP history entries. */
async function navigateHistory(drv: TabDriver, delta: number): Promise<void> {
  const hist: any = await drv.send("Page.getNavigationHistory", {});
  const target = hist.currentIndex + delta;
  if (target < 0 || target >= hist.entries.length) {
    throw new Error(delta < 0 ? "No page to go back to" : "No page to go forward to");
  }
  const loaded = drv.once("Page.loadEventFired", 30_000);
  await drv.send("Page.navigateToHistoryEntry", { entryId: hist.entries[target].id });
  await loaded;
}

// ── Tab attachment ──

let driver: TabDriver | null = null;

async function resolveTargetTabId(): Promise<number> {
  let tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  let tab = tabs[0];
  if (!tab) {
    tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = tabs[0];
  }
  if (!tab) {
    tabs = await chrome.tabs.query({ active: true });
    tab = tabs[0];
  }
  if (!tab || typeof tab.id !== "number") throw new Error("No active tab to control");
  const url: string = tab.url ?? "";
  if (/^(chrome|edge|brave|devtools|chrome-extension|about):/i.test(url) || url.startsWith("https://chromewebstore.google.com")) {
    throw new Error(`Can't control this page (${url || "internal page"}). Switch to a normal website tab and try again.`);
  }
  return tab.id;
}

/** Ensure we're attached to the current active tab; (re)attach + enable domains. */
async function ensureAttached(): Promise<TabDriver> {
  const tabId = await resolveTargetTabId();
  if (driver && driver.tabId === tabId) return driver;
  if (driver) {
    try {
      await chrome.debugger.detach({ tabId: driver.tabId });
    } catch {
      /* already gone */
    }
    driver = null;
  }
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/already attached/i.test(msg)) throw err;
  }
  const drv = new TabDriver(tabId);
  await drv.send("Page.enable").catch(() => {});
  await drv.send("DOM.enable").catch(() => {});
  await drv.send("Accessibility.enable").catch(() => {});
  await drv.send("Runtime.enable").catch(() => {});
  driver = drv;
  return drv;
}

// Route CDP events to the active driver.
chrome.debugger.onEvent.addListener((source: any, method: string, params: any) => {
  if (driver && source?.tabId === driver.tabId) driver.onEvent(method, params);
});

// If the user cancels the debugger banner (or the tab closes), drop the driver
// so the next command transparently re-attaches to the current active tab.
chrome.debugger.onDetach.addListener((source: any) => {
  if (driver && source?.tabId === driver.tabId) driver = null;
});

// ── Bridge connection ──

let socket: any = null;
let reconnectDelay = RECONNECT_MIN_MS;
let connecting = false;

function sendToBridge(msg: Record<string, unknown>): void {
  try {
    if (socket && socket.readyState === 1) socket.send(JSON.stringify(msg));
  } catch {
    /* ignore */
  }
}

async function handleCommand(id: string, action: BrowserAction): Promise<void> {
  try {
    const drv = await ensureAttached();
    const result = await executeAction(drv, action);
    sendToBridge({ type: "response", id, result });
  } catch (err) {
    sendToBridge({ type: "response", id, error: err instanceof Error ? err.message : String(err) });
  }
}

async function connect(): Promise<void> {
  if (connecting || (socket && (socket.readyState === 0 || socket.readyState === 1))) return;
  connecting = true;
  const cfg = await readBridgeConfig();
  if (!cfg) {
    connecting = false;
    scheduleReconnect();
    return;
  }
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${cfg.port}/`);
    socket = ws;
    ws.onopen = () => {
      reconnectDelay = RECONNECT_MIN_MS;
      sendToBridge({ type: "hello", secret: cfg.secret, capabilities: { chromeAvailable: true } });
    };
    ws.onmessage = (ev: any) => {
      let msg: any;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (msg.type === "ping") sendToBridge({ type: "pong" });
      else if (msg.type === "command") void handleCommand(msg.id, msg.action);
    };
    ws.onclose = () => {
      if (socket === ws) socket = null;
      scheduleReconnect();
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };
  } catch {
    socket = null;
    scheduleReconnect();
  } finally {
    connecting = false;
  }
}

function scheduleReconnect(): void {
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  setTimeout(() => void connect(), delay);
}

// ── Lifecycle / keepalive ──

chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_PERIOD_MIN });
chrome.alarms.onAlarm.addListener((alarm: any) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  // Touch the socket and ensure we're connected — also keeps the SW alive.
  if (socket && socket.readyState === 1) sendToBridge({ type: "ping" });
  else void connect();
});

chrome.runtime.onStartup?.addListener(() => void connect());
chrome.runtime.onInstalled?.addListener(() => void connect());

void connect();
