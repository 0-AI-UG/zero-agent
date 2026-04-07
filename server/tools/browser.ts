import { z } from "zod";
import { tool, generateText } from "ai";
import { getLocalBackend } from "@/lib/execution/lifecycle.ts";
import { buildFileManifest } from "@/tools/code.ts";
import type { BrowserAction } from "@/lib/browser/protocol.ts";
import { isModelMultimodal } from "@/config/models.ts";
import { getVisionModel } from "@/lib/providers/index.ts";
import { log } from "@/lib/logger.ts";

const toolLog = log.child({ module: "tool:browser" });

export function createBrowserTool(userId: string, projectId: string, modelId?: string) {
  return {
    browser: tool({
      description:
        "Control the browser. Actions: navigate (go to URL), click/type/select/hover (interact with elements by ref like [e1]), scroll, back/forward/reload, wait, snapshot (get page state), screenshot (capture visible page), evaluate (run JS in the page), tabs/switchTab/closeTab (manage tabs). Take a snapshot first to discover interactive elements, then use refs [e1], [e2] to interact. Snapshot modes: 'interactive' (default, flat list of buttons/links/inputs — cheap) or 'full' (complete accessibility tree with all text content — use when you need to read page text). You can also scope snapshots to a CSS selector. After click/type/select/hover/scroll, only a confirmation is returned — take a new snapshot if you need to see the updated page.\n\n" +
        "evaluate: runs JavaScript inside the active page. Top-level `await` is supported. The script's last expression is the return value (REPL mode). Returns { value, logs, error } plus the current url/title. A helper library is preloaded as `window.__agent` on every page with: $ / $$ (querySelector/All), byText(text,{tag,exact}), text(sel?), fill(sel,value), click(sel), waitFor(selOrFn,{timeout}), table(sel), attrs(sel), forms(), summary(). Prefer ref-based click/type for simple interactions; use evaluate for bulk extraction, multi-step DOM work, custom waits, or anything the a11y snapshot can't express.",
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
          z.object({
            type: z.literal("snapshot"),
            mode: z.enum(["interactive", "full"]).optional().describe("'interactive' (default): flat list of buttons, links, inputs. 'full': complete accessibility tree with all text content."),
            selector: z.string().optional().describe("CSS selector to scope the snapshot to (e.g. 'main', '#content', 'nav')"),
          }),
          z.object({ type: z.literal("screenshot") }),
          z.object({
            type: z.literal("evaluate"),
            script: z.string().describe("JavaScript to run in the page. Top-level `await` is supported; the last expression is returned. Use `window.__agent` helpers for common DOM tasks."),
            awaitPromise: z.boolean().optional().describe("Await a returned Promise before returning. Default: true."),
          }),
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
        if (result?.type === "evaluate") {
          const lines = [`evaluate result — ${result.title} (${result.url})`];
          if (result.error) {
            lines.push(`error: ${result.error}`);
          } else {
            const v = result.value;
            const valueStr = typeof v === "string" ? v : JSON.stringify(v, null, 2);
            lines.push(`value: ${valueStr ?? "undefined"}`);
          }
          if (Array.isArray(result.logs) && result.logs.length > 0) {
            lines.push("logs:");
            for (const l of result.logs as string[]) lines.push(`  ${l}`);
          }
          return { type: "text" as const, value: lines.join("\n") };
        }
        if (result?.type === "done") {
          const base = `${result.message} — ${result.title} (${result.url})`;
          if (typeof result.snapshot === "string") {
            return { type: "text" as const, value: `${base}\n\n${result.snapshot}` };
          }
          return { type: "text" as const, value: base };
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

        await backend.ensureContainer(userId, projectId);

        // Sync project files so file:// URLs resolve to up-to-date content
        if (action.type === "navigate" && action.url.startsWith("file://")) {
          const manifest = buildFileManifest(projectId);
          await backend.syncProjectFiles(projectId, manifest);
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
                const { text: caption } = await generateText({
                  model: getVisionModel(),
                  messages: [{
                    role: "user",
                    content: [
                      { type: "text", text: `Describe this browser screenshot in detail. Include all visible text, UI elements, layout, navigation state, and any errors or notable content. Page: ${result.title} (${result.url})` },
                      { type: "image", image: result.base64, mediaType: "image/jpeg" },
                    ],
                  }],
                });
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
