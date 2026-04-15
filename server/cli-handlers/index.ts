/**
 * Mount point for /api/runner-proxy/zero/* - the server-side handlers
 * for the in-container `zero` CLI/SDK.
 *
 * IMPORTANT: this directory is the ONLY place CLI-originated handlers
 * live. Code in server/tools/ is for in-process AI SDK tool functions
 * (called by ToolLoopAgent). Code here is for HTTP handlers reachable
 * only via a trusted runner proxy on behalf of a container CLI call.
 * The two trust models do not overlap. Do not cross-import.
 *
 * All handlers go through the `bind()` helper, which:
 *   1. Authenticates the runner bearer + resolves the container's
 *      (projectId, userId) into a CliContext.
 *   2. Parses the request body with the route's zod schema (shared with
 *      the SDK in zero/src/sdk/schemas.ts), so handlers receive a typed,
 *      already-validated input and never see raw JSON.
 *   3. Converts thrown ZodError / framework errors into the uniform
 *      { ok:false, error:{ code, message } } envelope.
 */
import type { Hono } from "hono";
import type { z, ZodTypeAny } from "zod";
import { ZodError } from "zod";
import { requireRunner } from "./middleware.ts";
import type { CliContext } from "./context.ts";
import { fail, failFromError } from "./response.ts";

import { handleHealth } from "./health.ts";
import { handleWebSearch, handleWebFetch } from "./web.ts";
import {
  handleScheduleAdd,
  handleScheduleList,
  handleScheduleUpdate,
  handleScheduleRemove,
} from "./schedule.ts";
import { handleImageGenerate } from "./image.ts";
import {
  handleCredsList,
  handleCredsGet,
  handleCredsSet,
  handleCredsRemove,
} from "./creds.ts";
import { handlePortsForward } from "./ports.ts";
import {
  handleBrowserOpen,
  handleBrowserClick,
  handleBrowserFill,
  handleBrowserScreenshot,
  handleBrowserEvaluate,
  handleBrowserWait,
  handleBrowserSnapshot,
  handleBrowserExtract,
} from "./browser.ts";
import { handleLlmGenerate } from "./llm.ts";
import { handleMessageSend, handleMessageResponse } from "./message.ts";
import { handleEmbed } from "./embed.ts";
import { handleSearch } from "./search.ts";

import {
  HealthInput,
  WebSearchInput,
  WebFetchInput,
  ScheduleAddInput,
  ScheduleListInput,
  ScheduleUpdateInput,
  ScheduleRemoveInput,
  ImageGenerateInput,
  CredsListInput,
  CredsGetInput,
  CredsSetInput,
  CredsRemoveInput,
  BrowserOpenInput,
  BrowserClickInput,
  BrowserFillInput,
  BrowserScreenshotInput,
  BrowserEvaluateInput,
  BrowserWaitInput,
  BrowserSnapshotInput,
  BrowserExtractInput,
  PortsForwardInput,
  LlmGenerateInput,
  MessageSendInput,
  MessageResponseInput,
  EmbedInput,
  SearchInput,
} from "zero/schemas";

type HonoApp = Hono<any, any, any>;

export type CliHandler<S extends ZodTypeAny> = (
  ctx: CliContext,
  input: z.infer<S>,
  req: Request,
) => Promise<Response>;

/**
 * Builds a Hono handler from an input schema and a typed CLI handler.
 * Auth, body parsing, validation, and error envelope are all centralised
 * here so individual route files contain only business logic.
 */
function bind<S extends ZodTypeAny>(schema: S, handler: CliHandler<S>) {
  return async (c: any) => {
    const req: Request = c.req.raw;
    let ctx: CliContext;
    try {
      ctx = await requireRunner(req);
    } catch (err) {
      return failFromError(err);
    }

    let raw: unknown;
    try {
      // POST handlers always send JSON; tolerate empty bodies for the
      // input-less routes (health, list endpoints) by defaulting to {}.
      const text = await req.text();
      raw = text.length === 0 ? {} : JSON.parse(text);
    } catch {
      return fail("bad_request", "Request body is not valid JSON", 400);
    }

    let input: z.infer<S>;
    try {
      input = schema.parse(raw) as z.infer<S>;
    } catch (err) {
      if (err instanceof ZodError) {
        const first = err.issues[0];
        const path = first?.path.join(".") || "(root)";
        return fail("bad_request", `${path}: ${first?.message ?? "invalid input"}`, 400);
      }
      return failFromError(err);
    }

    try {
      return await handler(ctx, input, req);
    } catch (err) {
      return failFromError(err);
    }
  };
}

/** Register all /api/runner-proxy/zero/* routes on the given Hono app. */
export function mountCliHandlers(app: HonoApp): void {
  app.post("/api/runner-proxy/zero/health", bind(HealthInput, handleHealth));

  app.post("/api/runner-proxy/zero/web/search", bind(WebSearchInput, handleWebSearch));
  app.post("/api/runner-proxy/zero/web/fetch", bind(WebFetchInput, handleWebFetch));

  app.post("/api/runner-proxy/zero/schedule/add", bind(ScheduleAddInput, handleScheduleAdd));
  app.post("/api/runner-proxy/zero/schedule/list", bind(ScheduleListInput, handleScheduleList));
  app.post("/api/runner-proxy/zero/schedule/update", bind(ScheduleUpdateInput, handleScheduleUpdate));
  app.post("/api/runner-proxy/zero/schedule/remove", bind(ScheduleRemoveInput, handleScheduleRemove));

  app.post("/api/runner-proxy/zero/image/generate", bind(ImageGenerateInput, handleImageGenerate));

  app.post("/api/runner-proxy/zero/creds/list", bind(CredsListInput, handleCredsList));
  app.post("/api/runner-proxy/zero/creds/get", bind(CredsGetInput, handleCredsGet));
  app.post("/api/runner-proxy/zero/creds/set", bind(CredsSetInput, handleCredsSet));
  app.post("/api/runner-proxy/zero/creds/remove", bind(CredsRemoveInput, handleCredsRemove));

  app.post("/api/runner-proxy/zero/browser/open", bind(BrowserOpenInput, handleBrowserOpen));
  app.post("/api/runner-proxy/zero/browser/click", bind(BrowserClickInput, handleBrowserClick));
  app.post("/api/runner-proxy/zero/browser/fill", bind(BrowserFillInput, handleBrowserFill));
  app.post("/api/runner-proxy/zero/browser/screenshot", bind(BrowserScreenshotInput, handleBrowserScreenshot));
  app.post("/api/runner-proxy/zero/browser/evaluate", bind(BrowserEvaluateInput, handleBrowserEvaluate));
  app.post("/api/runner-proxy/zero/browser/wait", bind(BrowserWaitInput, handleBrowserWait));
  app.post("/api/runner-proxy/zero/browser/snapshot", bind(BrowserSnapshotInput, handleBrowserSnapshot));
  app.post("/api/runner-proxy/zero/browser/extract", bind(BrowserExtractInput, handleBrowserExtract));

  app.post("/api/runner-proxy/zero/ports/forward", bind(PortsForwardInput, handlePortsForward));

  // -- llm --
  app.post("/api/runner-proxy/zero/llm/generate", bind(LlmGenerateInput, handleLlmGenerate));

  // -- message --
  app.post("/api/runner-proxy/zero/message/send", bind(MessageSendInput, handleMessageSend));
  app.post("/api/runner-proxy/zero/message/response", bind(MessageResponseInput, handleMessageResponse));

  // -- embed --
  app.post("/api/runner-proxy/zero/embed", bind(EmbedInput, handleEmbed));

  // -- search --
  app.post("/api/runner-proxy/zero/search", bind(SearchInput, handleSearch));
}
