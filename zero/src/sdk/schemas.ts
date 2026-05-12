/**
 * Single source of truth for `zero` route input schemas.
 *
 * Both ends of the wire import from this file:
 *   - The SDK (zero/src/sdk/*.ts) parses caller arguments before sending,
 *     so misuse from the agent's container produces an immediate, typed
 *     error instead of a network round-trip.
 *   - The server cli-handlers (server/cli-handlers/*.ts) parse request
 *     bodies via the shared wrap() helper in cli-handlers/index.ts and
 *     never see untyped JSON.
 *
 * Only INPUT schemas live here. Output shapes remain hand-rolled
 * interfaces in the per-group SDK files; turning them into schemas would
 * be a contract test, not a hardening fix, and is left for a follow-up.
 *
 * Conventions:
 *   - Bound every string field with .min(1) or an explicit .max() so a
 *     compromised script can't ship a 50MB query string through the proxy.
 *   - Bound numeric fields where the handler has a natural ceiling
 *     (browser wait ms, schedule cooldown).
 *   - Use .strict() on objects so unknown fields are rejected - it's
 *     cheap typo protection and keeps the wire surface honest.
 */
import { z } from "zod";

const NonEmpty = (max: number) => z.string().min(1).max(max);

export const HealthInput = z.object({}).strict();

// -- web --
export const WebSearchInput = z
  .object({ query: NonEmpty(500) })
  .strict();

export const WebFetchInput = z
  .object({
    url: NonEmpty(2048),
    query: z.string().max(500).optional(),
  })
  .strict();

// -- schedule --
const TriggerFilter = z.record(z.string(), z.string()).optional();

export const ScheduleAddInput = z
  .object({
    name: NonEmpty(200),
    prompt: NonEmpty(8000),
    triggerType: z.enum(["schedule", "event", "script"]).optional(),
    schedule: z.string().min(1).max(200).optional(),
    triggerEvent: z.string().min(1).max(200).optional(),
    triggerFilter: TriggerFilter,
    cooldownSeconds: z.number().int().min(0).max(86_400 * 30).optional(),
    maxSteps: z.number().int().min(1).max(5000).optional(),
    scriptPath: z.string().min(1).max(512).optional(),
  })
  .strict();

export const ScheduleListInput = z.object({}).strict();

export const ScheduleUpdateInput = z
  .object({
    taskId: NonEmpty(64),
    name: z.string().min(1).max(200).optional(),
    prompt: z.string().min(1).max(8000).optional(),
    schedule: z.string().min(1).max(200).optional(),
    triggerEvent: z.string().min(1).max(200).optional(),
    triggerFilter: TriggerFilter,
    cooldownSeconds: z.number().int().min(0).max(86_400 * 30).optional(),
    maxSteps: z.number().int().min(1).max(5000).nullable().optional(),
    scriptPath: z.string().min(1).max(512).nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export const ScheduleRemoveInput = z
  .object({ taskId: NonEmpty(64) })
  .strict();

// -- image --
export const ImageGenerateInput = z
  .object({
    prompt: NonEmpty(4000),
    path: z.string().min(1).max(512).optional(),
  })
  .strict();

// -- creds --
export const CredsListInput = z.object({}).strict();

export const CredsGetInput = z
  .object({
    label: z.string().min(1).max(200).optional(),
    siteUrl: z.string().min(1).max(2048).optional(),
    id: z.string().min(1).max(64).optional(),
    field: z.enum(["password", "totp", "username"]).optional(),
  })
  .strict()
  .refine((v) => !!(v.id || v.label || v.siteUrl), {
    message: "provide id, label, or siteUrl",
  });

export const CredsSetInput = z
  .object({
    label: NonEmpty(200),
    siteUrl: NonEmpty(2048),
    username: NonEmpty(200),
    password: NonEmpty(1024),
    totpSecret: z.string().min(1).max(256).optional(),
  })
  .strict();

export const CredsRemoveInput = z
  .object({
    id: z.string().min(1).max(64).optional(),
    label: z.string().min(1).max(200).optional(),
  })
  .strict()
  .refine((v) => !!(v.id || v.label), { message: "provide id or label" });

// -- apps --
export const AppsCreateInput = z
  .object({
    name: z.string().min(1).max(100).optional(),
  })
  .strict();

export const AppsDeleteInput = z
  .object({
    slug: z.string().min(1).max(100),
  })
  .strict();

export const AppsListInput = z.object({}).strict();

// -- browser --
export const BrowserOpenInput = z
  .object({ url: NonEmpty(2048), stealth: z.boolean().optional() })
  .strict();

export const BrowserClickInput = z
  .object({ ref: NonEmpty(200), stealth: z.boolean().optional() })
  .strict();

export const BrowserFillInput = z
  .object({
    ref: NonEmpty(200),
    text: z.string().max(10_000),
    submit: z.boolean().optional(),
    stealth: z.boolean().optional(),
  })
  .strict();

export const BrowserScreenshotInput = z
  .object({ stealth: z.boolean().optional() })
  .strict();

export const BrowserEvaluateInput = z
  .object({
    script: NonEmpty(20_000),
    awaitPromise: z.boolean().optional(),
    stealth: z.boolean().optional(),
  })
  .strict();

export const BrowserWaitInput = z
  .object({
    ms: z.number().int().min(0).max(10_000),
    stealth: z.boolean().optional(),
  })
  .strict();

export const BrowserSnapshotInput = z
  .object({
    mode: z.enum(["interactive", "full"]).optional(),
    selector: z.string().min(1).max(500).optional(),
    stealth: z.boolean().optional(),
  })
  .strict();

// Query-driven content extraction from the currently-loaded page. Server
// pulls outerHTML, runs it through Readability + keyword ranking, and returns
// the handful of paragraphs most relevant to `query` - roughly 1-3% of the
// tokens a full snapshot / HTML dump would cost.
export const BrowserExtractInput = z
  .object({
    query: NonEmpty(500),
    maxExcerpts: z.number().int().min(1).max(20).optional(),
    stealth: z.boolean().optional(),
  })
  .strict();

// -- llm --
export const LlmGenerateInput = z
  .object({
    prompt: NonEmpty(100_000),
    system: z.string().max(20_000).optional(),
    model: z.string().min(1).max(200).optional(),
    maxTokens: z.number().int().min(1).max(32_000).optional(),
  })
  .strict();

// -- message --
// `respond` turns the send into a two-way request: the server dispatches a
// notification to project members and waits for a reply. `timeoutMs` caps the
// wait (min 5s, max 30min). The server returns `{delivered, groupId, respond:true}`
// immediately; the SDK then polls `GET /zero/message/response` until resolved.
export const MessageSendInput = z
  .object({
    text: NonEmpty(8000),
    respond: z.boolean().optional(),
    timeoutMs: z.number().int().min(5_000).max(30 * 60_000).optional(),
  })
  .strict();

export const MessageResponseInput = z
  .object({
    groupId: NonEmpty(64),
  })
  .strict();

// -- embed --
export const EmbedInput = z
  .object({
    texts: z.array(z.string().min(1).max(10_000)).min(1).max(100),
  })
  .strict();

// -- search --
export const SearchInput = z
  .object({
    query: NonEmpty(2000),
    collections: z
      .array(z.enum(["file", "message"]))
      .min(1)
      .max(2)
      .optional(),
    topK: z.number().int().min(1).max(50).optional(),
  })
  .strict();

// -- trigger (script-trigger control plane) --
// `taskId` and `runId` are stamped into each request body by the SDK from
// ZERO_TRIGGER_TASK_ID / ZERO_TRIGGER_RUN_ID env vars set on the script
// process. The handler verifies the task belongs to the caller's project.
const TriggerIdent = {
  taskId: NonEmpty(64),
  runId: NonEmpty(64),
};

export const TriggerFireInput = z
  .object({
    ...TriggerIdent,
    prompt: z.string().min(1).max(8000).optional(),
    payload: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const TriggerStateGetInput = z
  .object({
    ...TriggerIdent,
    key: NonEmpty(200),
  })
  .strict();

export const TriggerStateSetInput = z
  .object({
    ...TriggerIdent,
    key: NonEmpty(200),
    // unknown JSON value (objects, arrays, primitives, null)
    value: z.unknown(),
  })
  .strict();

export const TriggerStateDeleteInput = z
  .object({
    ...TriggerIdent,
    key: NonEmpty(200),
  })
  .strict();

export const TriggerStateAllInput = z
  .object({ ...TriggerIdent })
  .strict();

// Convenience re-exports for SDK type inference.
export type WebSearchInputT = z.infer<typeof WebSearchInput>;
export type WebFetchInputT = z.infer<typeof WebFetchInput>;
export type ScheduleAddInputT = z.infer<typeof ScheduleAddInput>;
export type ScheduleUpdateInputT = z.infer<typeof ScheduleUpdateInput>;
export type ScheduleRemoveInputT = z.infer<typeof ScheduleRemoveInput>;
export type ImageGenerateInputT = z.infer<typeof ImageGenerateInput>;
export type CredsGetInputT = z.infer<typeof CredsGetInput>;
export type CredsSetInputT = z.infer<typeof CredsSetInput>;
export type CredsRemoveInputT = z.infer<typeof CredsRemoveInput>;
export type BrowserOpenInputT = z.infer<typeof BrowserOpenInput>;
export type BrowserClickInputT = z.infer<typeof BrowserClickInput>;
export type BrowserFillInputT = z.infer<typeof BrowserFillInput>;
export type BrowserEvaluateInputT = z.infer<typeof BrowserEvaluateInput>;
export type BrowserWaitInputT = z.infer<typeof BrowserWaitInput>;
export type BrowserSnapshotInputT = z.infer<typeof BrowserSnapshotInput>;
export type BrowserExtractInputT = z.infer<typeof BrowserExtractInput>;
export type AppsCreateInputT = z.infer<typeof AppsCreateInput>;
export type AppsDeleteInputT = z.infer<typeof AppsDeleteInput>;
export type AppsListInputT = z.infer<typeof AppsListInput>;
export type LlmGenerateInputT = z.infer<typeof LlmGenerateInput>;
export type MessageSendInputT = z.infer<typeof MessageSendInput>;
export type MessageResponseInputT = z.infer<typeof MessageResponseInput>;
export type EmbedInputT = z.infer<typeof EmbedInput>;
export type SearchInputT = z.infer<typeof SearchInput>;
