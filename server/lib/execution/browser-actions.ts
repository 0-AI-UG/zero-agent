/**
 * Browser action executor — server-side port of companion/src/actions.ts.
 * All CDP-based browser actions for the local execution backend.
 */
import type { CdpClient } from "./cdp.ts";
import type { BrowserAction, BrowserResult } from "@/lib/browser/protocol.ts";
import { log } from "@/lib/logger.ts";

const actionLog = log.child({ module: "browser-actions" });

export type RefMap = Map<string, { role: string; name: string; backendNodeId: number }>;

/** Per-session cursor position for natural stealth mouse movement. */
export type CursorState = { x: number; y: number };


function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Generate a cubic Bezier curve path from (x0,y0) to (x1,y1) with randomized control points.
 */
function bezierPath(x0: number, y0: number, x1: number, y1: number, steps: number): Array<{ x: number; y: number }> {
  const dx = x1 - x0;
  const dy = y1 - y0;

  const cp1x = x0 + dx * randomBetween(0.2, 0.4) + randomBetween(-50, 50);
  const cp1y = y0 + dy * randomBetween(0.2, 0.4) + randomBetween(-50, 50);
  const cp2x = x0 + dx * randomBetween(0.6, 0.8) + randomBetween(-50, 50);
  const cp2y = y0 + dy * randomBetween(0.6, 0.8) + randomBetween(-50, 50);

  const points: Array<{ x: number; y: number }> = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    const x = u * u * u * x0 + 3 * u * u * t * cp1x + 3 * u * t * t * cp2x + t * t * t * x1;
    const y = u * u * u * y0 + 3 * u * u * t * cp1y + 3 * u * t * t * cp2y + t * t * t * y1;
    const jitterX = i > 0 && i < steps ? randomBetween(-2, 2) : 0;
    const jitterY = i > 0 && i < steps ? randomBetween(-2, 2) : 0;
    points.push({ x: x + jitterX, y: y + jitterY });
  }
  return points;
}

async function humanMouseMove(cdp: CdpClient, toX: number, toY: number, cursor: CursorState): Promise<void> {
  const dist = Math.sqrt((toX - cursor.x) ** 2 + (toY - cursor.y) ** 2);
  const steps = Math.max(10, Math.min(25, Math.round(dist / 20)));
  const points = bezierPath(cursor.x, cursor.y, toX, toY, steps);

  for (const point of points) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
    await sleep(randomBetween(5, 20));
  }

  cursor.x = toX;
  cursor.y = toY;
}

async function humanType(cdp: CdpClient, text: string): Promise<void> {
  if (text.length > 200) {
    await cdp.send("Input.insertText", { text });
    return;
  }

  let charsSinceLastPause = 0;
  const pauseInterval = Math.round(randomBetween(5, 15));

  for (const char of text) {
    await cdp.send("Input.insertText", { text: char });
    let delay = randomBetween(40, 120);
    charsSinceLastPause++;
    if (charsSinceLastPause >= pauseInterval) {
      delay = randomBetween(200, 400);
      charsSinceLastPause = 0;
    }
    await sleep(delay);
  }
}

async function getPageInfo(cdp: CdpClient) {
  const result = await cdp.send("Runtime.evaluate", {
    expression: "JSON.stringify({ url: location.href, title: document.title })",
    returnByValue: true,
  });
  const { url, title } = JSON.parse(result.result.value);
  return { url, title };
}

async function waitForLoad(cdp: CdpClient, timeout = 10000) {
  // Check if already loaded (avoid waiting for event that already fired)
  try {
    const result = await cdp.send("Runtime.evaluate", {
      expression: "document.readyState",
      returnByValue: true,
    });
    if (result.result.value === "complete" || result.result.value === "interactive") return;
  } catch {}

  // Wait for Page.loadEventFired or timeout.
  // Use cdp.once() to avoid leaking listeners — each waitForLoad() call
  // would otherwise permanently add a listener to the CDP client.
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      cdp.off("Page.loadEventFired", handler);
      resolve();
    }, timeout);
    const handler = () => {
      clearTimeout(timer);
      cdp.off("Page.loadEventFired", handler);
      resolve();
    };
    cdp.on("Page.loadEventFired", handler);
  });
}

/** Wait until no network requests are in-flight for `idleMs`, up to `timeout`. */
async function waitForNetworkIdle(cdp: CdpClient, idleMs = 500, timeout = 5000): Promise<void> {
  await cdp.send("Network.enable").catch(() => {});

  let inflight = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  return new Promise<void>((resolve) => {
    const deadline = setTimeout(() => { cleanup(); resolve(); }, timeout);

    const onRequest = () => { inflight++; resetIdle(); };
    const onDone = () => { inflight = Math.max(0, inflight - 1); if (inflight === 0) startIdle(); };

    function startIdle() {
      idleTimer = setTimeout(() => { cleanup(); resolve(); }, idleMs);
    }
    function resetIdle() {
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    }
    function cleanup() {
      clearTimeout(deadline);
      if (idleTimer) clearTimeout(idleTimer);
      cdp.off("Network.requestWillBeSent", onRequest);
      cdp.off("Network.loadingFinished", onDone);
      cdp.off("Network.loadingFailed", onDone);
      cdp.send("Network.disable").catch(() => {});
    }

    cdp.on("Network.requestWillBeSent", onRequest);
    cdp.on("Network.loadingFinished", onDone);
    cdp.on("Network.loadingFailed", onDone);

    // If already idle, start the timer immediately
    startIdle();
  });
}

function resolveRef(refMap: RefMap, ref: string): number {
  const entry = refMap.get(ref);
  if (!entry) {
    throw new Error(`Element ref [${ref}] not found. Take a snapshot first to get current refs.`);
  }
  return entry.backendNodeId;
}

async function resolveNode(cdp: CdpClient, backendNodeId: number): Promise<string> {
  const { object } = await cdp.send("DOM.resolveNode", { backendNodeId });
  if (!object?.objectId) throw new Error("Could not resolve node — it may have been removed from the DOM. Take a new snapshot.");
  return object.objectId;
}

async function getNodeCenter(cdp: CdpClient, backendNodeId: number) {
  const objectId = await resolveNode(cdp, backendNodeId);

  const result = await cdp.send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `function() {
      const r = this.getBoundingClientRect();
      return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2, width: r.width, height: r.height });
    }`,
    returnByValue: true,
  });

  await cdp.send("Runtime.releaseObject", { objectId });
  return JSON.parse(result.result.value);
}

async function clickNode(cdp: CdpClient, backendNodeId: number, stealth?: boolean, cursor?: CursorState) {
  const objectId = await resolveNode(cdp, backendNodeId);
  await cdp.send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `function() { this.scrollIntoViewIfNeeded(); }`,
  }).catch(() => {});
  await cdp.send("Runtime.releaseObject", { objectId });

  const pos = await getNodeCenter(cdp, backendNodeId);

  if (stealth && cursor) {
    await humanMouseMove(cdp, pos.x, pos.y, cursor);
    await sleep(randomBetween(50, 150));
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
    await sleep(randomBetween(10, 50));
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
  } else {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pos.x, y: pos.y });
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
  }
}

async function focusAndType(cdp: CdpClient, backendNodeId: number, text: string, stealth?: boolean) {
  try {
    await cdp.send("DOM.focus", { backendNodeId });
  } catch {
    const pos = await getNodeCenter(cdp, backendNodeId);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pos.x, y: pos.y });
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
    const objectId = await resolveNode(cdp, backendNodeId);
    await cdp.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function() { this.focus(); }`,
    }).catch(() => {});
    await cdp.send("Runtime.releaseObject", { objectId });
  }

  const objectId = await resolveNode(cdp, backendNodeId);
  await cdp.send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `function() {
      if ('value' in this) { this.value = ''; this.dispatchEvent(new Event('input', { bubbles: true })); }
      else if (this.isContentEditable) { this.textContent = ''; this.dispatchEvent(new Event('input', { bubbles: true })); }
    }`,
  });
  await cdp.send("Runtime.releaseObject", { objectId });

  if (stealth) {
    await humanType(cdp, text);
  } else {
    await cdp.send("Input.insertText", { text });
  }
}

async function buildA11ySnapshot(
  cdp: CdpClient,
  options?: { relaxed?: boolean },
): Promise<{ content: string; refMap: Map<string, { role: string; name: string; backendNodeId: number }> }> {
  const refMap = new Map<string, { role: string; name: string; backendNodeId: number }>();
  let refCounter = 0;
  const relaxed = options?.relaxed ?? false;

  const { nodes } = await cdp.send("Accessibility.getFullAXTree", { depth: 50 }, 30_000);

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

  function renderNode(nodeId: string, depth: number) {
    const node = nodeMap.get(nodeId);
    if (!node) return;

    const role = node.role?.value ?? "";
    const name = node.name?.value ?? "";
    const backendNodeId = node.backendDOMNodeId;

    if (skipRoles.has(role)) {
      // Keep "generic" nodes that have a name and backendNodeId (likely interactive divs/spans)
      const keepGeneric = role === "generic" && name && backendNodeId;
      if (!keepGeneric) {
        const kids = children.get(nodeId) ?? [];
        for (const kid of kids) renderNode(kid, depth);
        return;
      }
    }

    const indent = "  ".repeat(depth);

    let ref = "";
    if (relaxed) {
      // In relaxed mode, give refs to any node with a backendNodeId
      if (backendNodeId) {
        refCounter++;
        const refId = `e${refCounter}`;
        ref = ` [ref=${refId}]`;
        refMap.set(refId, { role, name, backendNodeId });
      }
    } else if (backendNodeId && (interactiveRoles.has(role) || name)) {
      refCounter++;
      const refId = `e${refCounter}`;
      ref = ` [ref=${refId}]`;
      refMap.set(refId, { role, name, backendNodeId });
    }

    const nameStr = name ? ` "${name}"` : "";
    lines.push(`${indent}- ${role}${nameStr}${ref}`);

    const kids = children.get(nodeId) ?? [];
    for (const kid of kids) renderNode(kid, depth + 1);
  }

  const rootNode = nodes.find((n: any) => !n.parentId || n.role?.value === "RootWebArea");
  if (rootNode) {
    const kids = children.get(rootNode.nodeId) ?? [];
    for (const kid of kids) renderNode(kid, 0);
  }

  return { content: lines.join("\n"), refMap };
}


/** Per-session state for smart snapshot caching. */
export interface SnapshotCache {
  /** Set true by DOM.documentUpdated listener or after navigation. */
  dirty: boolean;
  /** Last rendered snapshot content, reused when tree is clean. */
  lastContent: string;
}

export async function executeAction(
  cdp: CdpClient,
  action: BrowserAction,
  cdpHost: string,
  cdpPort: number,
  refMap: RefMap,
  options?: { stealth?: boolean; cursor?: CursorState; snapshotCache?: SnapshotCache },
): Promise<BrowserResult> {
  const startTime = Date.now();
  const stealth = options?.stealth;
  const cursor = options?.cursor ?? { x: 0, y: 0 };
  const snapshotCache = options?.snapshotCache;
  actionLog.info("executeAction start", { action: action.type, cdpHost, stealth: !!stealth });

  async function fullSnapshot(): Promise<string> {
    const snapStart = Date.now();
    let snap = await buildA11ySnapshot(cdp);
    refMap.clear();
    for (const [k, v] of snap.refMap) refMap.set(k, v);

    // Fallback: if no refs found, retry with relaxed filtering
    if (refMap.size === 0) {
      actionLog.info("fullSnapshot: zero refs, retrying with relaxed filtering");
      snap = await buildA11ySnapshot(cdp, { relaxed: true });
      refMap.clear();
      for (const [k, v] of snap.refMap) refMap.set(k, v);
    }

    let content = snap.content;

    // If still empty, provide guidance instead of blank output
    if (!content && refMap.size === 0) {
      content = "[No interactive elements found in page accessibility tree. " +
        "Try: screenshot to see the page visually, evaluate to inspect the DOM with JavaScript, " +
        "or wait and snapshot again if the page is still loading.]";
    }

    if (snapshotCache) {
      snapshotCache.lastContent = content;
      snapshotCache.dirty = false;
    }
    actionLog.info("fullSnapshot complete", { refs: refMap.size, contentLength: content.length, elapsedMs: Date.now() - snapStart });
    return content;
  }

  /** Smart snapshot: skip full a11y tree rebuild when DOM hasn't changed. */
  async function autoSnapshot(urlBefore?: string): Promise<string> {
    // Always do full rebuild if no cache, cache is dirty, or URL changed (navigation)
    if (!snapshotCache || snapshotCache.dirty || !snapshotCache.lastContent) {
      return fullSnapshot();
    }
    // Check if URL changed (indicates navigation)
    if (urlBefore) {
      const { url: urlAfter } = await getPageInfo(cdp);
      if (urlAfter !== urlBefore) {
        return fullSnapshot();
      }
    }
    // Tree is clean — reuse cached snapshot
    actionLog.info("autoSnapshot skipped (tree clean)", { cachedLength: snapshotCache.lastContent.length });
    return snapshotCache.lastContent;
  }

  function isStaleNodeError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return msg.includes("does not belong to the document")
      || msg.includes("No node with given id found")
      || msg.includes("Could not resolve node")
      || msg.includes("not found — it may have been removed");
  }

  async function reResolveRef(ref: string): Promise<number> {
    await autoSnapshot();
    return resolveRef(refMap, ref);
  }

  switch (action.type) {
    case "navigate": {
      actionLog.info("navigate", { url: action.url });
      await cdp.send("Page.navigate", { url: action.url }, 30_000);
      await waitForLoad(cdp);
      await waitForNetworkIdle(cdp);
      const info = await getPageInfo(cdp);
      actionLog.info("navigate loaded", { url: info.url, title: info.title, elapsedMs: Date.now() - startTime });
      const snapshot = await fullSnapshot(); // Always rebuild after navigation
      return { type: "done", ...info, message: `Navigated to ${action.url}`, snapshot };
    }

    case "click": {
      actionLog.info("click", { ref: action.ref });
      const urlBefore = (await getPageInfo(cdp)).url;
      let nodeId = resolveRef(refMap, action.ref);
      try {
        await clickNode(cdp, nodeId, stealth, cursor);
      } catch (err) {
        if (isStaleNodeError(err)) {
          actionLog.info("click stale node, re-resolving", { ref: action.ref });
          try {
            nodeId = await reResolveRef(action.ref);
            await clickNode(cdp, nodeId, stealth, cursor);
          } catch {
            throw new Error(`Element [${action.ref}] no longer exists on the page. Take a new snapshot to see current elements.`);
          }
        } else throw err;
      }
      await waitForLoad(cdp, 5000).catch(() => {});
      const info = await getPageInfo(cdp);
      const snapshot = await autoSnapshot(urlBefore);
      actionLog.info("click done", { ref: action.ref, title: info.title, elapsedMs: Date.now() - startTime });
      return { type: "done", ...info, message: `Clicked [${action.ref}]`, snapshot };
    }

    case "type": {
      actionLog.info("type", { ref: action.ref, textLength: action.text.length, submit: action.submit });
      const urlBefore = (await getPageInfo(cdp)).url;
      let nodeId = resolveRef(refMap, action.ref);
      try {
        await focusAndType(cdp, nodeId, action.text, stealth);
      } catch (err) {
        if (isStaleNodeError(err)) {
          actionLog.info("type stale node, re-resolving", { ref: action.ref });
          try {
            nodeId = await reResolveRef(action.ref);
            await focusAndType(cdp, nodeId, action.text, stealth);
          } catch {
            throw new Error(`Element [${action.ref}] no longer exists on the page. Take a new snapshot to see current elements.`);
          }
        } else throw err;
      }
      if (action.submit) {
        await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
        await waitForLoad(cdp, 5000).catch(() => {});
      }
      const info = await getPageInfo(cdp);
      const snapshot = action.submit ? await autoSnapshot(urlBefore) : await autoSnapshot(urlBefore);
      actionLog.info("type done", { ref: action.ref, title: info.title, elapsedMs: Date.now() - startTime });
      return { type: "done", ...info, message: `Typed into [${action.ref}]`, snapshot };
    }

    case "select": {
      const urlBefore = (await getPageInfo(cdp)).url;
      let nodeId = resolveRef(refMap, action.ref);
      try {
        const objectId = await resolveNode(cdp, nodeId);
        await cdp.send("Runtime.callFunctionOn", {
          objectId,
          functionDeclaration: `function(val) {
            this.value = val;
            this.dispatchEvent(new Event('change', { bubbles: true }));
          }`,
          arguments: [{ value: action.value }],
        });
        await cdp.send("Runtime.releaseObject", { objectId });
      } catch (err) {
        if (isStaleNodeError(err)) {
          try {
            nodeId = await reResolveRef(action.ref);
            const objectId = await resolveNode(cdp, nodeId);
            await cdp.send("Runtime.callFunctionOn", {
              objectId,
              functionDeclaration: `function(val) {
                this.value = val;
                this.dispatchEvent(new Event('change', { bubbles: true }));
              }`,
              arguments: [{ value: action.value }],
            });
            await cdp.send("Runtime.releaseObject", { objectId });
          } catch {
            throw new Error(`Element [${action.ref}] no longer exists on the page. Take a new snapshot to see current elements.`);
          }
        } else throw err;
      }
      const info = await getPageInfo(cdp);
      const snapshot = await autoSnapshot(urlBefore);
      return { type: "done", ...info, message: `Selected "${action.value}" in [${action.ref}]`, snapshot };
    }

    case "hover": {
      let nodeId = resolveRef(refMap, action.ref);
      try {
        const { x, y } = await getNodeCenter(cdp, nodeId);
        if (stealth) {
          await humanMouseMove(cdp, x, y, cursor);
        } else {
          await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
        }
      } catch (err) {
        if (isStaleNodeError(err)) {
          try {
            nodeId = await reResolveRef(action.ref);
            const { x, y } = await getNodeCenter(cdp, nodeId);
            if (stealth) {
              await humanMouseMove(cdp, x, y, cursor);
            } else {
              await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
            }
          } catch {
            throw new Error(`Element [${action.ref}] no longer exists on the page. Take a new snapshot to see current elements.`);
          }
        } else throw err;
      }
      const info = await getPageInfo(cdp);
      // Hover doesn't change DOM — reuse cached snapshot
      const snapshot = await autoSnapshot(info.url);
      return { type: "done", ...info, message: `Hovered [${action.ref}]`, snapshot };
    }

    case "scroll": {
      const amount = action.amount ?? 500;
      const delta = action.direction === "down" ? amount : -amount;
      const scrollX = 400;
      const scrollY = 300;
      if (stealth) {
        await humanMouseMove(cdp, scrollX + randomBetween(-50, 50), scrollY + randomBetween(-50, 50), cursor);
      }
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: scrollX, y: scrollY, deltaX: 0, deltaY: delta });
      const info = await getPageInfo(cdp);
      // Scroll doesn't change DOM — reuse cached snapshot
      const snapshot = await autoSnapshot(info.url);
      return { type: "done", ...info, message: `Scrolled ${action.direction} ${amount}px`, snapshot };
    }

    case "back": {
      await cdp.send("Page.navigateToHistoryEntry",
        await cdp.send("Page.getNavigationHistory").then((h: any) => ({ entryId: h.entries[h.currentIndex - 1]?.id }))
      ).catch(() => {});
      await waitForLoad(cdp).catch(() => {});
      const info = await getPageInfo(cdp);
      return { type: "done", ...info, message: "Went back" };
    }

    case "forward": {
      await cdp.send("Page.navigateToHistoryEntry",
        await cdp.send("Page.getNavigationHistory").then((h: any) => ({ entryId: h.entries[h.currentIndex + 1]?.id }))
      ).catch(() => {});
      await waitForLoad(cdp).catch(() => {});
      const info = await getPageInfo(cdp);
      return { type: "done", ...info, message: "Went forward" };
    }

    case "reload": {
      await cdp.send("Page.reload");
      await waitForLoad(cdp);
      await waitForNetworkIdle(cdp);
      const info = await getPageInfo(cdp);
      const snapshot = await fullSnapshot(); // Always rebuild after reload
      return { type: "done", ...info, message: "Page reloaded", snapshot };
    }

    case "wait": {
      await new Promise((r) => setTimeout(r, Math.min(action.ms, 10000)));
      const info = await getPageInfo(cdp);
      return { type: "done", ...info, message: `Waited ${action.ms}ms` };
    }

    case "snapshot": {
      actionLog.info("snapshot start");
      const content = await fullSnapshot(); // Explicit snapshot always does full rebuild
      const info = await getPageInfo(cdp);
      actionLog.info("snapshot done", { refs: refMap.size, contentLength: content.length, title: info.title, elapsedMs: Date.now() - startTime });
      return { type: "snapshot", ...info, content };
    }

    case "screenshot": {
      actionLog.info("screenshot start");
      const result = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 75 }, 15_000);
      const info = await getPageInfo(cdp);
      actionLog.info("screenshot done", { base64Length: result.data?.length, title: info.title, elapsedMs: Date.now() - startTime });
      return { type: "screenshot", ...info, base64: result.data };
    }

    case "evaluate": {
      actionLog.info("evaluate", { scriptLength: action.script.length, scriptPreview: action.script.slice(0, 100) });
      const result = await cdp.send("Runtime.evaluate", {
        expression: action.script,
        returnByValue: true,
      });
      return { type: "evaluate", value: result.result?.value };
    }

    case "tabs": {
      const res = await fetch(`http://${cdpHost}:${cdpPort}/json/list`);
      const targets = (await res.json()) as Array<{ id: string; type: string; url: string; title: string }>;
      const pages = targets.filter((t) => t.type === "page");
      const tabs = pages.map((t, i) => ({
        index: i,
        url: t.url,
        title: t.title,
        active: false,
      }));
      return { type: "tabs", tabs };
    }

    case "switchTab": {
      const res = await fetch(`http://${cdpHost}:${cdpPort}/json/list`);
      const targets = (await res.json()) as Array<{ id: string; type: string; url: string; title: string }>;
      const pages = targets.filter((t) => t.type === "page");
      const target = pages[action.index];
      if (!target) throw new Error(`Tab index ${action.index} not found (${pages.length} tabs open)`);
      await fetch(`http://${cdpHost}:${cdpPort}/json/activate/${target.id}`);
      return { type: "done", url: target.url, title: target.title, message: `Switched to tab ${action.index}` };
    }

    case "closeTab": {
      const res = await fetch(`http://${cdpHost}:${cdpPort}/json/list`);
      const targets = (await res.json()) as Array<{ id: string; type: string; url: string; title: string }>;
      const pages = targets.filter((t) => t.type === "page");
      const idx = action.index ?? 0;
      const target = pages[idx];
      if (!target) throw new Error(`Tab index ${idx} not found`);
      await fetch(`http://${cdpHost}:${cdpPort}/json/close/${target.id}`);

      const remaining = pages.filter((_, i) => i !== idx);
      if (remaining[0]) {
        return { type: "done", url: remaining[0].url, title: remaining[0].title, message: `Closed tab ${idx}` };
      }
      return { type: "done", url: "", title: "", message: `Closed tab ${idx}, no tabs remaining` };
    }

    default:
      throw new Error(`Unknown action type: ${(action as any).type}`);
  }
}
