import type { CdpClient } from "./cdp.ts";
import type { BrowserAction, BrowserResult } from "./protocol.ts";

export type RefMap = Map<string, { role: string; name: string; backendNodeId: number }>;

// Track cursor position between actions for natural movement
let cursorX = 0;
let cursorY = 0;

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

  // Randomized control points — offset perpendicular to the line for natural arc
  const cp1x = x0 + dx * randomBetween(0.2, 0.4) + randomBetween(-50, 50);
  const cp1y = y0 + dy * randomBetween(0.2, 0.4) + randomBetween(-50, 50);
  const cp2x = x0 + dx * randomBetween(0.6, 0.8) + randomBetween(-50, 50);
  const cp2y = y0 + dy * randomBetween(0.6, 0.8) + randomBetween(-50, 50);

  const points: Array<{ x: number; y: number }> = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    // Cubic bezier formula
    const x = u * u * u * x0 + 3 * u * u * t * cp1x + 3 * u * t * t * cp2x + t * t * t * x1;
    const y = u * u * u * y0 + 3 * u * u * t * cp1y + 3 * u * t * t * cp2y + t * t * t * y1;
    // Add small jitter to simulate hand tremor (1-3px)
    const jitterX = i > 0 && i < steps ? randomBetween(-2, 2) : 0;
    const jitterY = i > 0 && i < steps ? randomBetween(-2, 2) : 0;
    points.push({ x: x + jitterX, y: y + jitterY });
  }
  return points;
}

/**
 * Move mouse along a natural Bezier curve path from current position to target.
 */
async function humanMouseMove(cdp: CdpClient, toX: number, toY: number): Promise<void> {
  const dist = Math.sqrt((toX - cursorX) ** 2 + (toY - cursorY) ** 2);
  // Scale steps with distance: 10-25 steps
  const steps = Math.max(10, Math.min(25, Math.round(dist / 20)));
  const points = bezierPath(cursorX, cursorY, toX, toY, steps);

  for (const point of points) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
    await sleep(randomBetween(5, 20));
  }

  cursorX = toX;
  cursorY = toY;
}

/**
 * Type text character-by-character with human-like timing.
 * For long text (>200 chars), falls back to instant paste.
 */
async function humanType(cdp: CdpClient, text: string): Promise<void> {
  if (text.length > 200) {
    await cdp.send("Input.insertText", { text });
    return;
  }

  let charsSinceLastPause = 0;
  const pauseInterval = Math.round(randomBetween(5, 15));

  for (const char of text) {
    await cdp.send("Input.insertText", { text: char });

    // Normal inter-keystroke delay: 40-120ms
    let delay = randomBetween(40, 120);

    charsSinceLastPause++;
    if (charsSinceLastPause >= pauseInterval) {
      // Occasional longer pause simulating micro-thinking
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
  // Wait for page to finish loading
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = await cdp.send("Runtime.evaluate", {
      expression: "document.readyState",
      returnByValue: true,
    });
    if (result.result.value === "complete" || result.result.value === "interactive") return;
    await new Promise((r) => setTimeout(r, 200));
  }
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

async function clickNode(cdp: CdpClient, backendNodeId: number, stealth?: boolean) {
  // Scroll into view first
  const objectId = await resolveNode(cdp, backendNodeId);
  await cdp.send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `function() { this.scrollIntoViewIfNeeded(); }`,
  }).catch(() => {});
  await cdp.send("Runtime.releaseObject", { objectId });

  const pos = await getNodeCenter(cdp, backendNodeId);

  if (stealth) {
    // Human-like mouse movement to target
    await humanMouseMove(cdp, pos.x, pos.y);
    // Reaction time before clicking (50-150ms)
    await sleep(randomBetween(50, 150));
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
    // Natural hold time between mouseDown and mouseUp (10-50ms)
    await sleep(randomBetween(10, 50));
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
  } else {
    // Fast mode: direct click with no artificial delays
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pos.x, y: pos.y });
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
  }
}

async function focusAndType(cdp: CdpClient, backendNodeId: number, text: string, stealth?: boolean) {
  // Focus the element — try DOM.focus first, fall back to click + JS .focus()
  // for elements that aren't natively focusable (contentEditable divs, role="textbox", etc.)
  try {
    await cdp.send("DOM.focus", { backendNodeId });
  } catch {
    // Click to focus, then JS focus as fallback
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

  // Clear existing value
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

/**
 * Build an accessibility tree snapshot using CDP Accessibility domain.
 * Returns a YAML-like format with [ref=eN] markers, similar to Playwright's ariaSnapshot.
 */
async function buildA11ySnapshot(cdp: CdpClient): Promise<{ content: string; refMap: Map<string, { role: string; name: string; backendNodeId: number }> }> {
  const refMap = new Map<string, { role: string; name: string; backendNodeId: number }>();
  let refCounter = 0;

  const { nodes } = await cdp.send("Accessibility.getFullAXTree", { depth: 50 });

  // Build parent-child map
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

  // Roles to skip (structural/invisible)
  const skipRoles = new Set([
    "none", "generic", "InlineTextBox", "LineBreak",
    "StaticText", "RootWebArea", "ignored",
  ]);

  // Roles that are interactive and should get refs
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
    if (skipRoles.has(role)) {
      // Still visit children
      const kids = children.get(nodeId) ?? [];
      for (const kid of kids) renderNode(kid, depth);
      return;
    }

    const name = node.name?.value ?? "";
    const indent = "  ".repeat(depth);
    const backendNodeId = node.backendDOMNodeId;

    let ref = "";
    if (backendNodeId && (interactiveRoles.has(role) || name)) {
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

  // Find root node
  const rootNode = nodes.find((n: any) => !n.parentId || n.role?.value === "RootWebArea");
  if (rootNode) {
    const kids = children.get(rootNode.nodeId) ?? [];
    for (const kid of kids) renderNode(kid, 0);
  }

  return { content: lines.join("\n"), refMap };
}


export async function executeAction(
  cdp: CdpClient,
  action: BrowserAction,
  cdpPort: number,
  refMap: RefMap,
  options?: { stealth?: boolean },
): Promise<BrowserResult> {
  const stealth = options?.stealth;

  /** Run buildA11ySnapshot, update refMap in-place, return content string. */
  async function autoSnapshot(): Promise<string> {
    const snap = await buildA11ySnapshot(cdp);
    refMap.clear();
    for (const [k, v] of snap.refMap) refMap.set(k, v);
    return snap.content;
  }

  /** Check if an error indicates a stale/detached DOM node. */
  function isStaleNodeError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return msg.includes("does not belong to the document")
      || msg.includes("No node with given id found")
      || msg.includes("Could not resolve node")
      || msg.includes("not found — it may have been removed");
  }

  /**
   * Re-snapshot and re-resolve a ref after a stale node error.
   * Returns the new backendNodeId, or throws if the ref can't be found.
   */
  async function reResolveRef(ref: string): Promise<number> {
    await autoSnapshot();
    return resolveRef(refMap, ref);
  }

  switch (action.type) {
    case "navigate": {
      await cdp.send("Page.navigate", { url: action.url });
      await waitForLoad(cdp);
      const info = await getPageInfo(cdp);
      const snapshot = await autoSnapshot();
      return { type: "done", ...info, message: `Navigated to ${action.url}`, snapshot };
    }

    case "click": {
      let nodeId = resolveRef(refMap, action.ref);
      try {
        await clickNode(cdp, nodeId, stealth);
      } catch (err) {
        if (isStaleNodeError(err)) {
          nodeId = await reResolveRef(action.ref);
          await clickNode(cdp, nodeId, stealth);
        } else throw err;
      }
      await waitForLoad(cdp, 5000).catch(() => {});
      const info = await getPageInfo(cdp);
      const snapshot = await autoSnapshot();
      return { type: "done", ...info, message: `Clicked [${action.ref}]`, snapshot };
    }

    case "type": {
      let nodeId = resolveRef(refMap, action.ref);
      try {
        await focusAndType(cdp, nodeId, action.text, stealth);
      } catch (err) {
        if (isStaleNodeError(err)) {
          nodeId = await reResolveRef(action.ref);
          await focusAndType(cdp, nodeId, action.text, stealth);
        } else throw err;
      }
      if (action.submit) {
        await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
        await waitForLoad(cdp, 5000).catch(() => {});
      }
      const info = await getPageInfo(cdp);
      const snapshot = await autoSnapshot();
      return { type: "done", ...info, message: `Typed into [${action.ref}]`, snapshot };
    }

    case "select": {
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
        } else throw err;
      }
      const info = await getPageInfo(cdp);
      const snapshot = await autoSnapshot();
      return { type: "done", ...info, message: `Selected "${action.value}" in [${action.ref}]`, snapshot };
    }

    case "hover": {
      let nodeId = resolveRef(refMap, action.ref);
      try {
        const { x, y } = await getNodeCenter(cdp, nodeId);
        if (stealth) {
          await humanMouseMove(cdp, x, y);
        } else {
          await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
        }
      } catch (err) {
        if (isStaleNodeError(err)) {
          nodeId = await reResolveRef(action.ref);
          const { x, y } = await getNodeCenter(cdp, nodeId);
          if (stealth) {
            await humanMouseMove(cdp, x, y);
          } else {
            await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
          }
        } else throw err;
      }
      const info = await getPageInfo(cdp);
      const snapshot = await autoSnapshot();
      return { type: "done", ...info, message: `Hovered [${action.ref}]`, snapshot };
    }

    case "scroll": {
      const amount = action.amount ?? 500;
      const delta = action.direction === "down" ? amount : -amount;
      const scrollX = 400;
      const scrollY = 300;
      if (stealth) {
        await humanMouseMove(cdp, scrollX + randomBetween(-50, 50), scrollY + randomBetween(-50, 50));
      }
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: scrollX, y: scrollY, deltaX: 0, deltaY: delta });
      const info = await getPageInfo(cdp);
      const snapshot = await autoSnapshot();
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
      const info = await getPageInfo(cdp);
      return { type: "done", ...info, message: "Page reloaded" };
    }

    case "wait": {
      await new Promise((r) => setTimeout(r, Math.min(action.ms, 10000)));
      const info = await getPageInfo(cdp);
      return { type: "done", ...info, message: `Waited ${action.ms}ms` };
    }

    case "snapshot": {
      const snapshot = await buildA11ySnapshot(cdp);
      refMap.clear();
      for (const [k, v] of snapshot.refMap) refMap.set(k, v);
      const info = await getPageInfo(cdp);
      return { type: "snapshot", ...info, content: snapshot.content };
    }

    case "screenshot": {
      const result = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 75 });
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
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
      const targets = (await res.json()) as Array<{ id: string; type: string; url: string; title: string }>;
      const pages = targets.filter((t) => t.type === "page");
      const tabs = pages.map((t, i) => ({
        index: i,
        url: t.url,
        title: t.title,
        active: false, // We don't track this in raw CDP
      }));
      return { type: "tabs", tabs };
    }

    case "switchTab": {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
      const targets = (await res.json()) as Array<{ id: string; type: string; url: string; title: string }>;
      const pages = targets.filter((t) => t.type === "page");
      const target = pages[action.index];
      if (!target) throw new Error(`Tab index ${action.index} not found (${pages.length} tabs open)`);
      await fetch(`http://127.0.0.1:${cdpPort}/json/activate/${target.id}`);
      return { type: "done", url: target.url, title: target.title, message: `Switched to tab ${action.index}` };
    }

    case "closeTab": {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
      const targets = (await res.json()) as Array<{ id: string; type: string; url: string; title: string }>;
      const pages = targets.filter((t) => t.type === "page");
      const idx = action.index ?? 0;
      const target = pages[idx];
      if (!target) throw new Error(`Tab index ${idx} not found`);
      await fetch(`http://127.0.0.1:${cdpPort}/json/close/${target.id}`);

      // Return info about remaining tab
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
