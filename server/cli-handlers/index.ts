/**
 * Builder for the per-turn unix-socket Hono app served by `cli-socket.ts`.
 *
 * IMPORTANT: this directory is the ONLY place CLI-originated handlers
 * live. Code here is for HTTP handlers reachable only via a per-turn
 * unix socket bind-mounted into a Pi sandbox. Authentication is the
 * `X-Pi-Run-Token` header registered by `runTurn`. Do not import
 * `authenticateRequest` here — the trust model is different.
 *
 * All handlers go through the `bind()` helper, which:
 *   1. Resolves the per-turn token into a CliContext.
 *   2. Parses the request body with the route's zod schema (shared with
 *      the SDK in zero/src/sdk/schemas.ts), so handlers receive a typed,
 *      already-validated input and never see raw JSON.
 *   3. Converts thrown ZodError / framework errors into the uniform
 *      { ok:false, error:{ code, message } } envelope.
 */
import { Hono } from "hono";
import type { z, ZodTypeAny } from "zod";
import { ZodError } from "zod";
import { requirePi } from "./middleware.ts";
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
      ctx = await requirePi(req);
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

/**
 * Returns the Hono app served on a per-turn unix socket. Mounted by
 * `runTurn` via `cli-socket.ts`; nothing in `server/index.ts` needs to
 * call this anymore.
 */
export function buildCliHandlerApp(): Hono {
  const app = new Hono();

  app.post("/zero/health", bind(HealthInput, handleHealth));

  app.post("/zero/web/search", bind(WebSearchInput, handleWebSearch));
  app.post("/zero/web/fetch", bind(WebFetchInput, handleWebFetch));

  app.post("/zero/schedule/add", bind(ScheduleAddInput, handleScheduleAdd));
  app.post("/zero/schedule/list", bind(ScheduleListInput, handleScheduleList));
  app.post("/zero/schedule/update", bind(ScheduleUpdateInput, handleScheduleUpdate));
  app.post("/zero/schedule/remove", bind(ScheduleRemoveInput, handleScheduleRemove));

  app.post("/zero/image/generate", bind(ImageGenerateInput, handleImageGenerate));

  app.post("/zero/creds/list", bind(CredsListInput, handleCredsList));
  app.post("/zero/creds/get", bind(CredsGetInput, handleCredsGet));
  app.post("/zero/creds/set", bind(CredsSetInput, handleCredsSet));
  app.post("/zero/creds/remove", bind(CredsRemoveInput, handleCredsRemove));

  app.post("/zero/browser/open", bind(BrowserOpenInput, handleBrowserOpen));
  app.post("/zero/browser/click", bind(BrowserClickInput, handleBrowserClick));
  app.post("/zero/browser/fill", bind(BrowserFillInput, handleBrowserFill));
  app.post("/zero/browser/screenshot", bind(BrowserScreenshotInput, handleBrowserScreenshot));
  app.post("/zero/browser/evaluate", bind(BrowserEvaluateInput, handleBrowserEvaluate));
  app.post("/zero/browser/wait", bind(BrowserWaitInput, handleBrowserWait));
  app.post("/zero/browser/snapshot", bind(BrowserSnapshotInput, handleBrowserSnapshot));
  app.post("/zero/browser/extract", bind(BrowserExtractInput, handleBrowserExtract));

  app.post("/zero/ports/forward", bind(PortsForwardInput, handlePortsForward));

  app.post("/zero/llm/generate", bind(LlmGenerateInput, handleLlmGenerate));

  app.post("/zero/message/send", bind(MessageSendInput, handleMessageSend));
  app.post("/zero/message/response", bind(MessageResponseInput, handleMessageResponse));

  app.post("/zero/embed", bind(EmbedInput, handleEmbed));

  app.post("/zero/search", bind(SearchInput, handleSearch));

  return app;
}
