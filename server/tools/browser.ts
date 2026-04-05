import { z } from "zod";
import { tool, generateText } from "ai";
import { getLocalBackend } from "@/lib/execution/lifecycle.ts";
import type { BrowserAction } from "@/lib/browser/protocol.ts";
import { isModelMultimodal } from "@/config/models.ts";
import { getVisionModel } from "@/lib/openrouter.ts";
import { deferAsync } from "@/lib/deferred.ts";
import { log } from "@/lib/logger.ts";

const toolLog = log.child({ module: "tool:browser" });

export function createBrowserTool(userId: string, projectId: string, modelId?: string) {
  return {
    browser: tool({
      description:
        "Control the browser. Actions: navigate (go to URL), click/type/select/hover (interact with elements by ref like [e1]), scroll, back/forward/reload, wait, snapshot (get page accessibility tree), screenshot (capture visible page), evaluate (run JS), tabs/switchTab/closeTab (manage tabs). Always take a snapshot first to see the page, then use element refs [e1], [e2] etc. to interact. Mutating actions (click, type, select, hover, scroll, navigate) automatically return an updated snapshot.",
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
        if (result?.type === "caption" && typeof result.caption === "string") {
          return {
            type: "text" as const,
            value: `Screenshot of: ${result.title} (${result.url})\n\n[Browser screenshot description]\n${result.caption}`,
          };
        }
        if (result?.type === "screenshot" && typeof result.base64 === "string") {
          return {
            type: "content" as const,
            value: [
              { type: "text" as const, text: `Screenshot of: ${result.title} (${result.url})` },
              { type: "image-data" as const, data: result.base64, mediaType: "image/jpeg" },
            ],
          };
        }
        if (result?.type === "snapshot" && typeof result.content === "string") {
          return {
            type: "text" as const,
            value: `Page snapshot: ${result.title} (${result.url})\n\n${result.content}`,
          };
        }
        if (result?.type === "done" && typeof result.snapshot === "string") {
          return {
            type: "text" as const,
            value: `${result.message} — ${result.title} (${result.url})\n\n${result.snapshot}`,
          };
        }
        return { type: "json" as const, value: (output ?? null) as import("@ai-sdk/provider").JSONValue };
      },
      execute: async ({ action, stealth }) => {
        const startTime = Date.now();
        toolLog.info("browser action start", { userId, projectId, action: action.type, stealth: !!stealth, modelId });

        const backend = getLocalBackend();
        if (!backend?.isReady()) {
          toolLog.warn("no browser backend available", { userId, projectId });
          return { error: "Code execution is not available. Docker may not be running." };
        }

        // Execute with retry on transient failures
        const MAX_RETRIES = 2;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
          const attemptStart = Date.now();
          try {
            const result = await backend.execute(userId, projectId, action as BrowserAction, stealth);
            toolLog.info("browser action completed", {
              userId, projectId, action: action.type,
              resultType: result?.type, attempt,
              elapsedMs: Date.now() - attemptStart,
            });

            // Caption screenshots for non-multimodal models
            if (modelId && !isModelMultimodal(modelId) && result?.type === "screenshot" && typeof result.base64 === "string") {
              try {
                const { text: caption } = await deferAsync(() => generateText({
                  model: getVisionModel(),
                  messages: [{
                    role: "user",
                    content: [
                      { type: "text", text: `Describe this browser screenshot in detail. Include all visible text, UI elements, layout, navigation state, and any errors or notable content. Page: ${result.title} (${result.url})` },
                      { type: "image", image: result.base64, mediaType: "image/jpeg" },
                    ],
                  }],
                }));
                return { type: "caption" as const, url: result.url, title: result.title, caption };
              } catch (err) {
                toolLog.warn("screenshot captioning failed", { error: String(err) });
                return { type: "caption" as const, url: result.url, title: result.title, caption: `[Screenshot of ${result.title} at ${result.url} — image captioning unavailable]` };
              }
            }

            return result;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const isTransient = message.includes("timed out") || message.includes("not connected") || message.includes("closed");

            toolLog.warn("browser action attempt failed", { userId, projectId, action: action.type, attempt, isTransient, error: message });

            if (isTransient && attempt < MAX_RETRIES) {
              const retryDelay = 2000 * (attempt + 1);
              await new Promise((r) => setTimeout(r, retryDelay));
              continue;
            }

            toolLog.error("browser action failed permanently", err, { userId, projectId, action: action.type, totalMs: Date.now() - startTime });
            return { error: message };
          }
        }

        return { error: "Browser action failed after retries" };
      },
    }),
  };
}
