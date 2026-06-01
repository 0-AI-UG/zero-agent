/**
 * Browser CLI handlers — back the `zero browser ...` per-turn-socket calls
 * with the host-side Playwright pool (`server/lib/browser/host-pool.ts`).
 *
 * Pre-Pi the runner had its own browser; now it lives on the host, keyed
 * per project. Screenshot output is still written into the project as a
 * file so the agent can `readFile` it by path.
 */
import type { z } from "zod";
import { getBrowserPool } from "@/lib/browser/host-pool.ts";
import { processHtml } from "@/lib/media/fetch-page.ts";
import { insertFile } from "@/db/queries/files.ts";
import { createFolder as createFolderRecord, getFolderByPath } from "@/db/queries/folders.ts";
import { writeProjectFile, workspacePathFor } from "@/lib/projects/fs-ops.ts";
import { sanitizePath } from "@/lib/files/sanitize.ts";
import { sha256Hex } from "@/lib/utils/hash.ts";
import type { CliContext } from "./context.ts";
import { ok, fail } from "./response.ts";
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

/**
 * Per-call browser options derived from the request principal. `allowCompanion`
 * is true only for user-initiated turns / direct laptop CLI use, so automated
 * runs never drive the user's local browser.
 */
function browserOpts(ctx: CliContext): { userId: string; allowCompanion: boolean } {
  return { userId: ctx.userId, allowCompanion: ctx.userInitiated };
}

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

async function dispatch(
  ctx: CliContext,
  fn: () => Promise<unknown>,
): Promise<Response> {
  try {
    return ok(await fn());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail("browser_failed", message, 500);
  }
}

export const handleBrowserOpen = (
  ctx: CliContext,
  input: z.infer<typeof BrowserOpenInput>,
) => dispatch(ctx, () =>
  getBrowserPool().execute(ctx.projectId, { type: "navigate", url: input.url }, browserOpts(ctx)),
);

export const handleBrowserClick = (
  ctx: CliContext,
  input: z.infer<typeof BrowserClickInput>,
) => dispatch(ctx, () =>
  getBrowserPool().execute(ctx.projectId, { type: "click", ref: input.ref }, browserOpts(ctx)),
);

export const handleBrowserFill = (
  ctx: CliContext,
  input: z.infer<typeof BrowserFillInput>,
) => dispatch(ctx, () =>
  getBrowserPool().execute(ctx.projectId, {
    type: "type",
    ref: input.ref,
    text: input.text,
    submit: !!input.submit,
  }, browserOpts(ctx)),
);

/**
 * Capture a screenshot, write it to project storage as `.zero/screenshots/...jpg`,
 * and return a compact `{path, fileId, sizeBytes, ...}` reference. The base64
 * payload is intentionally not surfaced to the CLI — keeping the bash tool
 * result tiny.
 */
export const handleBrowserScreenshot = async (
  ctx: CliContext,
  _input: z.infer<typeof BrowserScreenshotInput>,
): Promise<Response> => {
  let shot: { base64?: string; url?: string; title?: string };
  try {
    shot = (await getBrowserPool().execute(ctx.projectId, { type: "screenshot" }, browserOpts(ctx))) as {
      base64?: string; url?: string; title?: string;
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail("browser_failed", message, 500);
  }
  if (!shot?.base64) {
    return fail("browser_failed", "screenshot returned no image data", 500);
  }

  const buffer = Buffer.from(shot.base64, "base64");
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = sanitizePath(`.zero/screenshots/shot-${ts}.jpg`);
  const filename = filePath.split("/").pop() ?? `shot-${ts}.jpg`;
  const folderPath = "/" + filePath.split("/").slice(0, -1).join("/") + "/";

  ensureFoldersExist(ctx.projectId, folderPath);
  await writeProjectFile(ctx.projectId, workspacePathFor(folderPath, filename), buffer);

  const fileRow = insertFile(
    ctx.projectId, filename, "image/jpeg", buffer.byteLength, folderPath,
    sha256Hex(buffer),
  );

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
) => dispatch(ctx, () =>
  getBrowserPool().execute(ctx.projectId, {
    type: "evaluate",
    script: input.script,
    awaitPromise: input.awaitPromise !== false,
  }, browserOpts(ctx)),
);

export const handleBrowserWait = (
  ctx: CliContext,
  input: z.infer<typeof BrowserWaitInput>,
) => dispatch(ctx, () =>
  getBrowserPool().execute(ctx.projectId, { type: "wait", ms: input.ms }, browserOpts(ctx)),
);

export const handleBrowserSnapshot = (
  ctx: CliContext,
  input: z.infer<typeof BrowserSnapshotInput>,
) => dispatch(ctx, () =>
  getBrowserPool().execute(ctx.projectId, {
    type: "snapshot",
    mode: input.mode ?? "interactive",
    selector: input.selector,
  }, browserOpts(ctx)),
);

/**
 * `zero browser extract` — pull outerHTML out of the live page, run it
 * through the same Readability + keyword-ranking pipeline as `zero web fetch`,
 * and return only the highest-scoring paragraphs for `query`. Token-cheap
 * alternative to dumping a full snapshot.
 */
export const handleBrowserExtract = async (
  ctx: CliContext,
  input: z.infer<typeof BrowserExtractInput>,
): Promise<Response> => {
  let html = "";
  let url = "";
  let pageTitle = "";
  try {
    const result = (await getBrowserPool().execute(ctx.projectId, {
      type: "evaluate",
      script: "document.documentElement.outerHTML",
      awaitPromise: false,
      maxChars: 500_000,
    }, browserOpts(ctx))) as { value?: unknown; url?: string; title?: string };
    html = typeof result?.value === "string" ? result.value : "";
    url = typeof result?.url === "string" ? result.url : "";
    pageTitle = typeof result?.title === "string" ? result.title : "";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail("browser_failed", `extract: ${message}`, 500);
  }

  if (!html) {
    return ok({
      url, title: pageTitle, query: input.query, excerpts: [],
      note: "page returned no HTML — is a page loaded? try `zero browser open <url>` first",
    });
  }

  const truncated = /\[\.\.\.truncated, \d+ chars omitted\]$/.test(html);
  const { title, content, relevantExcerpts } = processHtml(html, url || "about:blank", input.query);
  const maxExcerpts = input.maxExcerpts ?? 5;
  const excerpts = (relevantExcerpts ?? []).slice(0, maxExcerpts);

  return ok({
    url,
    title: title || pageTitle,
    query: input.query,
    excerpts,
    contentChars: content?.length ?? 0,
    truncated: truncated || undefined,
  });
};
