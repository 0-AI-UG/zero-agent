/**
 * Browser handler - wraps the existing runner browser API by calling
 * the same `backend.execute` path the in-process `browser` tool uses.
 *
 * Note: the captioning fallback for non-multimodal models that lives in
 * server/tools/browser.ts is intentionally NOT carried over. When the
 * agent invokes `zero browser ...` from bash it has already chosen to
 * work with raw output.
 */
import type { z } from "zod";
import { ensureBackend } from "@/lib/execution/lifecycle.ts";
import type { BrowserAction } from "@/lib/browser/protocol.ts";
import { processHtml } from "@/lib/media/fetch-page.ts";
import { writeToS3 } from "@/lib/s3.ts";
import { insertFile } from "@/db/queries/files.ts";
import { createFolder as createFolderRecord, getFolderByPath } from "@/db/queries/folders.ts";
import { createThumbnail, thumbnailS3Key } from "@/lib/media/thumbnail.ts";
import { sanitizePath } from "@/lib/files/sanitize.ts";
import { sha256Hex } from "@/lib/execution/manifest-cache.ts";
import type { CliContext } from "./context.ts";
import { ok, fail } from "./response.ts";

function ensureFoldersExist(projectId: string, folderPath: string) {
  if (folderPath === "/") return;
  const segments = folderPath.split("/").filter(Boolean);
  let currentPath = "/";
  for (const segment of segments) {
    currentPath += segment + "/";
    if (!getFolderByPath(projectId, currentPath)) {
      createFolderRecord(projectId, currentPath, segment);
    }
  }
}
import type {
  BrowserOpenInput,
  BrowserClickInput,
  BrowserFillInput,
  BrowserScreenshotInput,
  BrowserEvaluateInput,
  BrowserWaitInput,
  BrowserSnapshotInput,
  BrowserExtractInput,
} from "zero/schemas";

async function dispatch(
  ctx: CliContext,
  action: BrowserAction,
  stealth?: boolean,
): Promise<Response> {
  const backend = await ensureBackend();
  if (!backend?.isReady()) return fail("no_backend", "Code execution is not available", 503);

  await backend.ensureContainer(ctx.userId, ctx.projectId);
  // writeFile/editFile/delete push directly to the container, so no pre-action sync is needed.

  const MAX_RETRIES = 2;
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await backend.execute(ctx.userId, ctx.projectId, action, stealth);
      return ok(result);
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      const isTransient = message.includes("timed out") || message.includes("not connected") || message.includes("closed");
      if (isTransient && attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      break;
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  return fail("browser_failed", message, 500);
}

export const handleBrowserOpen = (
  ctx: CliContext,
  input: z.infer<typeof BrowserOpenInput>,
) => dispatch(ctx, { type: "navigate", url: input.url } as BrowserAction, input.stealth);

export const handleBrowserClick = (
  ctx: CliContext,
  input: z.infer<typeof BrowserClickInput>,
) => dispatch(ctx, { type: "click", ref: input.ref } as BrowserAction, input.stealth);

export const handleBrowserFill = (
  ctx: CliContext,
  input: z.infer<typeof BrowserFillInput>,
) => dispatch(
  ctx,
  { type: "type", ref: input.ref, text: input.text, submit: !!input.submit } as BrowserAction,
  input.stealth,
);

/**
 * Screenshot handler. Captures via the runner (which already downscales to
 * ≤1024px JPEG@60), then writes the image directly to project storage and
 * reconciles into the container so the agent can immediately `readFile` it
 * by its project-relative path. The base64 payload never leaves the server -
 * the CLI only ever sees a compact `{path, fileId, sizeBytes, ...}` reference,
 * which keeps the bash tool result tiny.
 *
 * Screenshots are observation artefacts, not user-authored files.
 */
export const handleBrowserScreenshot = async (
  ctx: CliContext,
  input: z.infer<typeof BrowserScreenshotInput>,
): Promise<Response> => {
  const backend = await ensureBackend();
  if (!backend?.isReady()) return fail("no_backend", "Code execution is not available", 503);
  await backend.ensureContainer(ctx.userId, ctx.projectId);

  let shot: { base64?: string; url?: string; title?: string };
  try {
    shot = (await backend.execute(
      ctx.userId,
      ctx.projectId,
      { type: "screenshot" } as BrowserAction,
      input.stealth,
    )) as { base64?: string; url?: string; title?: string };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail("browser_failed", message, 500);
  }

  if (!shot?.base64) {
    return fail("browser_failed", "screenshot returned no image data", 500);
  }

  const buffer = Buffer.from(shot.base64, "base64");
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const rawPath = `.zero/screenshots/shot-${ts}.jpg`;
  const filePath = sanitizePath(rawPath);
  const s3Key = `projects/${ctx.projectId}/${filePath}`;
  const filename = filePath.split("/").pop() ?? `shot-${ts}.jpg`;
  const folderPath = "/" + filePath.split("/").slice(0, -1).join("/") + "/";

  ensureFoldersExist(ctx.projectId, folderPath);
  await writeToS3(s3Key, buffer);

  const fileRow = insertFile(
    ctx.projectId, filename, "image/jpeg", buffer.byteLength, folderPath,
    sha256Hex(buffer),
  );

  try {
    const thumbBuf = await createThumbnail(buffer);
    const thumbKey = thumbnailS3Key(s3Key);
    await writeToS3(thumbKey, thumbBuf);
  } catch {
    // thumbnail failure is non-fatal
  }

  // The watcher will pick up the new file and update the index.
  // Container visibility happens via the system tarball on next restore.

  return ok({
    type: "screenshot",
    url: shot.url ?? "",
    title: shot.title ?? "",
    path: filePath,
    fileId: fileRow.id,
    sizeBytes: buffer.byteLength,
    mediaType: "image/jpeg",
  });
};

export const handleBrowserEvaluate = (
  ctx: CliContext,
  input: z.infer<typeof BrowserEvaluateInput>,
) => dispatch(
  ctx,
  { type: "evaluate", script: input.script, awaitPromise: input.awaitPromise !== false } as BrowserAction,
  input.stealth,
);

export const handleBrowserWait = (
  ctx: CliContext,
  input: z.infer<typeof BrowserWaitInput>,
) => dispatch(ctx, { type: "wait", ms: input.ms } as BrowserAction, input.stealth);

export const handleBrowserSnapshot = (
  ctx: CliContext,
  input: z.infer<typeof BrowserSnapshotInput>,
) => dispatch(
  ctx,
  { type: "snapshot", mode: input.mode ?? "interactive", selector: input.selector } as BrowserAction,
  input.stealth,
);

/**
 * `zero browser extract` - query-driven content extraction.
 *
 * Pulls the page's outerHTML from the live browser session, runs it through
 * the same Readability + keyword-ranking pipeline used by `zero web fetch`,
 * and returns only the highest-scoring paragraphs for `query`. This avoids
 * dumping thousands of tokens of a11y tree / HTML into the agent context
 * when all the agent actually needs is a specific fact (price, date,
 * headline). Patterned after how browser-use 1.0 "queries" pages instead of
 * dumping them.
 */
export const handleBrowserExtract = async (
  ctx: CliContext,
  input: z.infer<typeof BrowserExtractInput>,
): Promise<Response> => {
  const backend = await ensureBackend();
  if (!backend?.isReady()) return fail("no_backend", "Code execution is not available", 503);
  await backend.ensureContainer(ctx.userId, ctx.projectId);

  // Grab outerHTML via an in-page evaluate. Cap the value hard on the runner
  // side is fine here - we just need the HTML string end-to-end.
  let html = "";
  let url = "";
  let pageTitle = "";
  try {
    const result = (await backend.execute(
      ctx.userId,
      ctx.projectId,
      {
        type: "evaluate",
        script: "document.documentElement.outerHTML",
        awaitPromise: false,
        // Override the default 4KB evaluate cap - we need full HTML so the
        // server-side Readability pass has real content to work with.
        maxChars: 500_000,
      } as BrowserAction,
      input.stealth,
    )) as { value?: unknown; url?: string; title?: string };
    html = typeof result?.value === "string" ? result.value : "";
    url = typeof result?.url === "string" ? result.url : "";
    pageTitle = typeof result?.title === "string" ? result.title : "";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail("browser_failed", `extract: ${message}`, 500);
  }

  if (!html) {
    return ok({
      url,
      title: pageTitle,
      query: input.query,
      excerpts: [],
      note: "page returned no HTML - is a page loaded? try `zero browser open <url>` first",
    });
  }

  // The runner evaluate cap is now 4KB - too small for full-page outerHTML,
  // so the runner would truncate before we see it. Detect the truncation
  // marker and warn; the extract result is still useful on what we did get.
  const truncated = /\[\.\.\.truncated, \d+ chars omitted\]$/.test(html);

  const { title, content, relevantExcerpts } = processHtml(html, url || "about:blank", input.query);
  const maxExcerpts = input.maxExcerpts ?? 5;
  const excerpts = (relevantExcerpts ?? []).slice(0, maxExcerpts);

  return ok({
    url,
    title: title || pageTitle,
    query: input.query,
    excerpts,
    ...(truncated ? { warning: "page HTML was truncated by the runner evaluate cap; results are partial" } : {}),
  });
};
