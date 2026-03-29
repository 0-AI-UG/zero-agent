import { z } from "zod";
import { tool } from "ai";
import { browserBridge } from "@/lib/browser/bridge.ts";
import type { BrowserAction } from "@/lib/browser/protocol.ts";
import { log } from "@/lib/logger.ts";

const toolLog = log.child({ module: "tool:browser" });

export function createBrowserTool(userId: string, projectId: string, initialSessionId?: string, lazySession?: { id: string; created: boolean; label?: string }) {
  let sessionId = initialSessionId;
  return {
    browser: tool({
      description:
        "Control the user's browser via the companion agent. Actions: navigate (go to URL), click/type/select/hover (interact with elements by ref like [e1]), scroll, back/forward/reload, wait, snapshot (get page accessibility tree), screenshot (capture visible page), evaluate (run JS), tabs/switchTab/closeTab (manage tabs). Always take a snapshot first to see the page, then use element refs [e1], [e2] etc. to interact. Mutating actions (click, type, select, hover, scroll, navigate) automatically return an updated snapshot.",
      inputSchema: z.object({
        stealth: z.boolean().optional().describe("Enable human-like mouse movement and typing delays for bot detection avoidance. Default: false (fast mode)."),
        action: z.discriminatedUnion("type", [
          z.object({ type: z.literal("navigate"), url: z.string().describe("URL to navigate to") }),
          z.object({ type: z.literal("click"), ref: z.string().describe("Element ref like 'e1'") }),
          z.object({
            type: z.literal("type"),
            ref: z.string().describe("Element ref like 'e1'"),
            text: z.string().describe("Text to type"),
            submit: z.boolean().optional().describe("Press Enter after typing"),
          }),
          z.object({
            type: z.literal("select"),
            ref: z.string().describe("Element ref like 'e1'"),
            value: z.string().describe("Option value to select"),
          }),
          z.object({ type: z.literal("hover"), ref: z.string().describe("Element ref like 'e1'") }),
          z.object({
            type: z.literal("scroll"),
            direction: z.enum(["up", "down"]),
            amount: z.number().optional().describe("Pixels to scroll (default 500)"),
          }),
          z.object({ type: z.literal("back") }),
          z.object({ type: z.literal("forward") }),
          z.object({ type: z.literal("reload") }),
          z.object({ type: z.literal("wait"), ms: z.number().max(10000).describe("Milliseconds to wait") }),
          z.object({ type: z.literal("snapshot") }),
          z.object({ type: z.literal("screenshot") }),
          z.object({ type: z.literal("evaluate"), script: z.string().describe("JavaScript to evaluate in page") }),
          z.object({ type: z.literal("tabs") }),
          z.object({ type: z.literal("switchTab"), index: z.number().describe("Tab index to switch to") }),
          z.object({ type: z.literal("closeTab"), index: z.number().optional().describe("Tab index to close") }),
        ]),
      }),
      toModelOutput({ output }) {
        const result = output as Record<string, unknown>;
        if (result?.type === "screenshot" && typeof result.base64 === "string") {
          return {
            type: "content" as const,
            value: [
              { type: "text" as const, text: `Screenshot of: ${result.title} (${result.url})` },
              { type: "image-data" as const, data: result.base64, mediaType: "image/jpeg" },
            ],
          };
        }
        // Done results with auto-snapshot: render as text for readability
        if (result?.type === "done" && typeof result.snapshot === "string") {
          return {
            type: "text" as const,
            value: `${result.message} — ${result.title} (${result.url})\n\n${result.snapshot}`,
          };
        }
        // Other results (snapshot, done without snapshot, evaluate, tabs, error) → default JSON
        return { type: "json" as const, value: (output ?? null) as import("@ai-sdk/provider").JSONValue };
      },
      execute: async ({ action, stealth }) => {
        toolLog.info("browser action", { userId, projectId, action: action.type });

        // Wait for companion with backoff: 1s, 2s, 4s (total ~7s)
        if (!browserBridge.isConnected(userId, projectId)) {
          for (const delay of [1000, 2000, 4000]) {
            await new Promise((r) => setTimeout(r, delay));
            if (browserBridge.isConnected(userId, projectId)) break;
          }
        }
        if (!browserBridge.isConnected(userId, projectId)) {
          return {
            error:
              "Browser companion is not connected. The user needs to start the companion agent on their machine and connect it with a token from Settings.",
          };
        }

        // Lazily create browser session on first use
        if (lazySession && !lazySession.created) {
          try {
            await browserBridge.createSession(userId, projectId, lazySession.id, lazySession.label);
            lazySession.created = true;
            sessionId = lazySession.id;
          } catch (err) {
            toolLog.warn("failed to create browser session lazily", { error: String(err) });
          }
        }

        // Execute with retry on transient failures (timeout, connection lost)
        const MAX_RETRIES = 2;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
          try {
            const result = await browserBridge.execute(userId, projectId, action as BrowserAction, sessionId, stealth);
            return result;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const isTransient = message.includes("timed out") || message.includes("not connected") || message.includes("closed");

            if (isTransient && attempt < MAX_RETRIES) {
              toolLog.info("browser action transient failure, retrying", { userId, projectId, action: action.type, attempt: attempt + 1 });
              await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
              // Re-check connection after wait
              if (!browserBridge.isConnected(userId, projectId)) {
                return { error: "Browser companion disconnected during retry. Please check the companion agent." };
              }
              continue;
            }

            toolLog.error("browser action failed", err, { userId, projectId, action: action.type });
            return { error: message };
          }
        }

        return { error: "Browser action failed after retries" };
      },
    }),
  };
}
