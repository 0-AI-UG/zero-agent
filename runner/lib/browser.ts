/**
 * Browser action executor — CDP-based browser automation.
 */
import type { CdpClient } from "./cdp.ts";
import type { BrowserAction, BrowserResult } from "./types.ts";
import { log } from "./logger.ts";

const actionLog = log.child({ module: "browser-actions" });

export type RefMap = Map<string, { role: string; name: string; backendNodeId: number }>;
export type CursorState = { x: number; y: number };

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

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
  try {
    const result = await cdp.send("Runtime.evaluate", {
      expression: "document.readyState",
      returnByValue: true,
    });
    if (result.result.value === "complete" || result.result.value === "interactive") return;
  } catch {}

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

/** Max lines for a full snapshot before truncation. Interactive-only snapshots are not limited. */
const MAX_SNAPSHOT_LINES = 400;

async function buildA11ySnapshot(
  cdp: CdpClient,
  options?: { relaxed?: boolean; interactiveOnly?: boolean; selector?: string },
): Promise<{ content: string; truncated?: boolean; refMap: Map<string, { role: string; name: string; backendNodeId: number }> }> {
  const refMap = new Map<string, { role: string; name: string; backendNodeId: number }>();
  let refCounter = 0;
  const relaxed = options?.relaxed ?? false;
  const interactiveOnly = options?.interactiveOnly ?? false;

  // If selector is provided, scope the tree to that element's subtree
  let rootBackendNodeId: number | undefined;
  if (options?.selector) {
    try {
      const { object } = await cdp.send("Runtime.evaluate", {
        expression: `JSON.stringify((() => { const el = document.querySelector(${JSON.stringify(options.selector)}); return el ? true : false })())`,
        returnByValue: true,
      });
      if (JSON.parse(object.value)) {
        const doc = await cdp.send("DOM.getDocument", { depth: 0 });
        const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: options.selector });
        if (nodeId) {
          const { node } = await cdp.send("DOM.describeNode", { nodeId });
          rootBackendNodeId = node.backendNodeId;
        }
      }
    } catch {
      // Fall through to full tree if selector fails
    }
  }

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

  // If scoped to a selector, find the subtree root in the A11y tree
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
        const kids = children.get(nodeId) ?? [];
        for (const kid of kids) renderNode(kid, depth);
        return;
      }
    }

    const isInteractive = interactiveRoles.has(role);

    // In interactive-only mode, skip non-interactive elements but still recurse into children
    if (interactiveOnly && !isInteractive) {
      const kids = children.get(nodeId) ?? [];
      for (const kid of kids) renderNode(kid, depth);
      return;
    }

    // Check line budget before adding
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
    // In interactive-only mode, render as flat list (no indentation)
    if (interactiveOnly) {
      lines.push(`- ${role}${nameStr}${ref}`);
    } else {
      const indent = "  ".repeat(depth);
      lines.push(`${indent}- ${role}${nameStr}${ref}`);
    }

    if (!interactiveOnly) {
      const kids = children.get(nodeId) ?? [];
      for (const kid of kids) renderNode(kid, depth + 1);
    }
  }

  // Start from scoped node or root
  const startNode = scopeNodeId
    ? nodeMap.get(scopeNodeId)
    : nodes.find((n: any) => !n.parentId || n.role?.value === "RootWebArea");

  if (startNode) {
    if (scopeNodeId) {
      renderNode(scopeNodeId, 0);
    } else {
      const kids = children.get(startNode.nodeId) ?? [];
      for (const kid of kids) renderNode(kid, 0);
    }
  }

  if (truncated) {
    lines.push(`\n[...truncated at ${lineLimit} lines — use snapshot with a CSS selector to see specific sections, e.g. selector: "main", "article", "#content"]`);
  }

  return { content: lines.join("\n"), truncated, refMap };
}

/** Strip ref annotations from a snapshot line for content-identity comparison. */
function stripRefs(line: string): string {
  return line.replace(/ \[ref=e\d+\]/g, "");
}

/** Threshold: if more than this fraction of lines are unchanged, use incremental format. */
const INCREMENTAL_THRESHOLD = 0.5;

export interface SnapshotCache {
  dirty: boolean;
  lastContent: string;
  /** Ref-stripped lines from previous snapshot, for incremental diffing. */
  prevLines?: string[];
  /** URL of the page when prevLines was captured. */
  prevUrl?: string;
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

  async function takeSnapshot(opts?: { interactiveOnly?: boolean; selector?: string }): Promise<string> {
    const snapStart = Date.now();
    const interactiveOnly = opts?.interactiveOnly ?? false;
    let snap = await buildA11ySnapshot(cdp, { interactiveOnly, selector: opts?.selector });
    refMap.clear();
    for (const [k, v] of snap.refMap) refMap.set(k, v);

    if (refMap.size === 0) {
      actionLog.info("takeSnapshot: zero refs, retrying with relaxed filtering");
      snap = await buildA11ySnapshot(cdp, { relaxed: true, interactiveOnly, selector: opts?.selector });
      refMap.clear();
      for (const [k, v] of snap.refMap) refMap.set(k, v);
    }

    let content = snap.content;

    if (!content && refMap.size === 0) {
      content = "[No interactive elements found in page accessibility tree. " +
        "Try: snapshot with mode 'full' to see all content, screenshot to see the page visually, " +
        "evaluate to inspect the DOM with JavaScript, or wait and snapshot again if the page is still loading.]";
    }

    // Attempt incremental diff against previous snapshot
    const currentLines = content.split("\n");
    const currentStripped = currentLines.map(stripRefs);
    const { url: currentUrl } = await getPageInfo(cdp);

    if (
      snapshotCache?.prevLines &&
      snapshotCache.prevUrl === currentUrl &&
      !opts?.selector // selectors change scope, always send full
    ) {
      const prevSet = new Set(snapshotCache.prevLines);
      const currSet = new Set(currentStripped);

      const added: string[] = [];
      const removed: string[] = [];

      // Lines in current but not in previous (use original lines with refs)
      for (let i = 0; i < currentLines.length; i++) {
        if (!prevSet.has(currentStripped[i]!)) {
          added.push(currentLines[i]!);
        }
      }
      // Lines in previous but not in current (ref-stripped, since old refs are stale)
      for (const prevLine of snapshotCache.prevLines) {
        if (!currSet.has(prevLine)) {
          removed.push(prevLine);
        }
      }

      const unchanged = currentLines.length - added.length;
      const isIncremental = unchanged / Math.max(currentLines.length, 1) >= INCREMENTAL_THRESHOLD;

      if (isIncremental && (added.length > 0 || removed.length > 0)) {
        const parts: string[] = [];
        parts.push(`[Incremental snapshot — ${unchanged} unchanged, ${added.length} added, ${removed.length} removed]`);

        if (added.length > 0) {
          parts.push("", "Added:", ...added);
        }
        if (removed.length > 0) {
          parts.push("", "Removed:", ...removed);
        }

        // Always include interactive elements with current refs
        const interactiveLines = currentLines.filter((_, i) => {
          const line = currentStripped[i]!;
          return /^-?\s*- (button|link|textbox|checkbox|radio|combobox|menuitem|tab|switch|slider|searchbox|spinbutton|option)/.test(line.trimStart());
        });
        if (interactiveLines.length > 0) {
          parts.push("", "Interactive elements:", ...interactiveLines);
        }

        content = parts.join("\n");
        actionLog.info("takeSnapshot incremental", {
          unchanged, added: added.length, removed: removed.length,
          interactiveElements: interactiveLines.length,
          fullLength: currentLines.length, incrementalLength: content.length,
          elapsedMs: Date.now() - snapStart,
        });
      }
    }

    // Update cache
    if (snapshotCache) {
      snapshotCache.lastContent = content;
      snapshotCache.prevLines = currentStripped;
      snapshotCache.prevUrl = currentUrl;
      snapshotCache.dirty = false;
    }
    actionLog.info("takeSnapshot complete", { interactiveOnly, refs: refMap.size, contentLength: content.length, elapsedMs: Date.now() - snapStart });
    return content;
  }

  /** Take an interactive-only snapshot only if navigation occurred. Returns undefined if no nav. */
  async function snapshotIfNavigated(urlBefore: string): Promise<string | undefined> {
    const { url: urlAfter } = await getPageInfo(cdp);
    if (urlAfter !== urlBefore) {
      return takeSnapshot({ interactiveOnly: true });
    }
    return undefined;
  }

  function isStaleNodeError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return msg.includes("does not belong to the document")
      || msg.includes("No node with given id found")
      || msg.includes("Could not resolve node")
      || msg.includes("not found — it may have been removed");
  }

  async function reResolveRef(ref: string): Promise<number> {
    await takeSnapshot({ interactiveOnly: true });
    return resolveRef(refMap, ref);
  }

  switch (action.type) {
    case "navigate": {
      await cdp.send("Page.navigate", { url: action.url }, 30_000);
      await waitForLoad(cdp);
      await waitForNetworkIdle(cdp);
      const info = await getPageInfo(cdp);
      const snapshot = await takeSnapshot({ interactiveOnly: true });
      return { type: "done", ...info, message: `Navigated to ${action.url}`, snapshot };
    }

    case "click": {
      const urlBefore = (await getPageInfo(cdp)).url;
      let nodeId = resolveRef(refMap, action.ref);
      try {
        await clickNode(cdp, nodeId, stealth, cursor);
      } catch (err) {
        if (isStaleNodeError(err)) {
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
      if (snapshotCache) snapshotCache.dirty = true;
      const snapshot = await snapshotIfNavigated(urlBefore);
      return { type: "done", ...info, message: `Clicked [${action.ref}]`, snapshot };
    }

    case "type": {
      const urlBefore = (await getPageInfo(cdp)).url;
      let nodeId = resolveRef(refMap, action.ref);
      try {
        await focusAndType(cdp, nodeId, action.text, stealth);
      } catch (err) {
        if (isStaleNodeError(err)) {
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
      if (snapshotCache) snapshotCache.dirty = true;
      const snapshot = await snapshotIfNavigated(urlBefore);
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
      if (snapshotCache) snapshotCache.dirty = true;
      const snapshot = await snapshotIfNavigated(urlBefore);
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
      if (snapshotCache) snapshotCache.dirty = true;
      return { type: "done", ...info, message: `Hovered [${action.ref}]` };
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
      if (snapshotCache) snapshotCache.dirty = true;
      return { type: "done", ...info, message: `Scrolled ${action.direction} ${amount}px` };
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
      const snapshot = await takeSnapshot({ interactiveOnly: true });
      return { type: "done", ...info, message: "Page reloaded", snapshot };
    }

    case "wait": {
      await new Promise((r) => setTimeout(r, Math.min(action.ms, 10000)));
      const info = await getPageInfo(cdp);
      return { type: "done", ...info, message: `Waited ${action.ms}ms` };
    }

    case "snapshot": {
      const interactiveOnly = action.mode !== "full";
      const content = await takeSnapshot({ interactiveOnly, selector: action.selector });
      const info = await getPageInfo(cdp);
      return { type: "snapshot", ...info, content };
    }

    case "screenshot": {
      const result = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 75 }, 15_000);
      const info = await getPageInfo(cdp);
      return { type: "screenshot", ...info, base64: result.data };
    }

    case "evaluate": {
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
      const tabs = pages.map((t, i) => ({ index: i, url: t.url, title: t.title, active: false }));
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
