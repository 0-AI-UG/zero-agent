# Replace AI SDK with `@openrouter/sdk` + WS-only Transport

## Context

Today the agent runtime is built on the Vercel AI SDK (`ai`, `@ai-sdk/react`, `@ai-sdk/provider-utils`, etc.). The SDK provides streaming, the `ToolLoopAgent`, tool schema validation, the `UIMessage` parts protocol, embeddings, image generation, and the `useChat` client hook. We also already maintain a persistent authenticated websocket (`server/lib/http/ws.ts`) used today only for presence and stream lifecycle events — chat content still flows over HTTP/SSE.

The change makes the **server the single source of truth** for conversation state and uses **the existing websocket as the only chat transport**. Inference + agent loop + embeddings move to `@openrouter/sdk` (beta 0.12.0, ESM-only). Image generation, which OpenRouter SDK does not cover, becomes a direct HTTP call to OpenRouter's chat completions with `modalities:["image"]`. This eliminates the AI SDK entirely.

Cutover is **big-bang on a branch** — no feature flag. The persisted message shape is **migrated to OpenRouter's items shape** (chosen by the user); renderers and stored messages are rewritten as part of this work.

Outcome: one provider SDK, one client transport, server-owned chat state, much thinner client (no `useChat` machinery).

## Pre-work spikes (do FIRST on the branch)

- **Spike A — `@openrouter/sdk` surface.** Install the package; verify against `node_modules/@openrouter/sdk`: (1) `callModel` streaming event shape; (2) tool schema format (Zod direct vs JSON Schema); (3) whether a single-step primitive exists or only the auto-loop with `stopWhen`; (4) embeddings API; (5) reasoning + usage fields; (6) Anthropic `cacheControl: ephemeral` passthrough; (7) the "items-based streaming" shape we're adopting as canonical.
- **Spike B — Image gen.** Confirm OpenRouter's REST endpoint accepts `modalities:["image"]` directly. Sketch the ~30-line `fetch` replacement for `generateImage()`.
- **Spike C — Compaction prep.** Confirm whether `callModel` exposes a per-step hook. Expectation: no — we wrap a single-step primitive in our own loop so `prepareStep` keeps working.

## Target architecture

- **Canonical message shape** = OpenRouter items. Define `server/lib/messages/types.ts` re-exporting / aliasing the SDK item types so the rest of the codebase imports from one place.
- **Agent loop** = `server/lib/agent/loop.ts`, hand-rolled around the SDK's single-step primitive: `prepareStep` → call SDK → handle tool calls → `onStepFinish` → repeat until `stopWhen`.
- **Streaming** = adapter publishes part events to a per-`chatId` `EventEmitter` (`server/lib/chat-bus/index.ts`). HTTP/SSE goes away.
- **Transport** = WS only. New `chat.*` message types (below). Server pushes a snapshot on subscribe, then deltas.
- **Persistence** = SQLite messages table stores items-shape JSON. One-shot migration converts existing rows.

### WS protocol additions

Client → server:
- `chat.send {chatId, text, attachments?, model, language, disabledTools, planMode}`
- `chat.stop {chatId}`
- `chat.regenerate {chatId, messageId}`
- `chat.approve {syncId, verdict}`
- `chat.snapshotRequest {chatId}` (optional — `viewChat` already triggers one)

Server → client:
- `chat.snapshot {chatId, messages, isStreaming, streamId, seq}`
- `chat.message.start {chatId, messageId, role, seq}`
- `chat.part.delta {chatId, messageId, partIndex, patch, seq}`
- `chat.part.complete {chatId, messageId, partIndex, part, seq}`
- `chat.message.finish {chatId, messageId, metadata, seq}`
- `chat.stream.error {chatId, error}`
- `chat.stream.ended {chatId, reason}`
- `chat.sync.created {chatId, syncId, ...}` (replaces HTTP-driven approval notification)

Existing `stream.started`/`stream.ended` stay for presence.

## Phased work (all on one branch)

### Phase 0 — Scaffolding
**Create:**
- `server/lib/messages/types.ts` — canonical Message/Part types from OpenRouter items.
- `server/lib/messages/converters.ts` — `toProviderMessages()`, `fromProviderEvents()`, plus a one-time `legacyUiMessageToItems()` for migration.
- `server/lib/openrouter/client.ts` — wraps `@openrouter/sdk`. Exposes `streamStep`, `generateText`, `embed`. Centralizes auth, retries, model selection.
- `server/lib/chat-bus/index.ts` — per-`chatId` EventEmitter with `subscribe(chatId)`, `publish(chatId, event)`, `getSnapshot(chatId)`, monotonic `seq`.

**Verify:** unit test round-tripping items through the adapter against a real OpenRouter key.

### Phase 1 — Replace agent loop + non-agent inference
**Create:**
- `server/lib/agent/loop.ts` — `runAgentLoop({model, messages, tools, instructions, prepareStep, onStepFinish, onPartEvent, signal, stopWhen})`.
- `server/lib/agent/tools-adapter.ts` — converts existing `tool({inputSchema: zod, execute})` to OpenRouter's expected shape (likely JSON Schema via `zod-to-json-schema`).

**Modify:**
- `server/lib/agent/agent.ts` — replace `ToolLoopAgent` construction with `runAgentLoop`. Keep `createAgent`'s public signature.
- `server/lib/agent-step/index.ts` — `runAgentStepStreaming` and `runAgentStepBatch` route through new loop. Streaming variant becomes WS-publishing (Phase 2); batch variant returns the result directly.
- `server/lib/conversation/compact-conversation.ts` + `compaction-state.ts` + `memory-flush.ts` + `clear-stale-results.ts` — drop `ModelMessage`/`PrepareStepFunction`/`UIMessage` imports; use canonical types.
- `server/lib/search/vectors.ts` — `embedMany` → adapter `embed`.
- `server/lib/media/image.ts` — replace `generateImage` with direct `fetch` to OpenRouter (per Spike B).
- `server/cli-handlers/llm.ts`, `server/cli-handlers/embed.ts` — replace AI SDK calls with adapter.
- `server/tools/files.ts:162` (image caption), `server/lib/chat-providers/telegram/provider.ts:435`, `server/lib/scheduling/heartbeat-explore.ts:76` — `generateText` → adapter `generateText`.
- All `server/tools/*.ts` — keep `tool({...})` shape but import from a thin local re-export so we can drop `from "ai"` everywhere.

**Verify:** vitest suite green; Telegram batch path produces equivalent output on a fixture; sub-agent spawner works; autonomous run produces a checkpoint.

### Phase 2 — WS chat transport (server)
**Create:**
- `server/lib/agent-step/ws-entrypoint.ts` — wraps `runAgentStepStreaming`'s logic; routes `onPartEvent` callbacks into `chat-bus` instead of building an SSE response. Persists messages on finish (reuse `server/lib/agent-step/hooks.ts`).
- `server/lib/http/ws-chat.ts` — handlers for new C→S types; dispatches to `ws-entrypoint`, abort controller per chat for `chat.stop`.

**Modify:**
- `server/lib/http/ws.ts` — extend `handleMessage` switch with `chat.send`/`chat.stop`/`chat.regenerate`/`chat.approve`/`chat.snapshotRequest`. On `viewChat`, deliver `chat.snapshot` from `chat-bus` (or DB if no active stream).
- `server/lib/sync-approval.ts` — broadcast approval requests via `chat-bus` (`chat.sync.created`); accept verdicts from the WS handler. Server detects "all approvals received" and resumes the loop server-side (this logic moves off the client).

**Delete:**
- `server/routes/chat.ts` (POST `/chat`)
- `server/routes/stream.ts` (resumable SSE reconnect)
- All uses of `createAgentUIStreamResponse`, `smoothStream`, `createNewResumableStream`, `resumable-stream` package.

**Verify:** headless WS client test — send `chat.send`, assert `start → delta* → finish` arrive in order with monotonic `seq`. Reconnect test: subscribe mid-stream, receive snapshot then live deltas with no gaps.

### Phase 3 — Client cutover
**Create:**
- `web/src/lib/messages.ts` — mirror server canonical Message/Part types.
- `web/src/lib/chat-ws.ts` — small reducer: WS `chat.*` events → `messages` state. Maintains seq, drops out-of-order events, applies snapshot on subscribe.
- `web/src/hooks/use-ws-chat.ts` — `useWsChat(chatId)` returning `{messages, sendMessage, stop, regenerate, status, error}`. Drop-in for current `useChat` consumers.

**Modify:**
- `web/src/components/chat/ChatPanel.tsx` — replace `useChat` + `DefaultChatTransport` with `useWsChat`. Remove `resume`, `resumeStream`, transport, refetch-on-stream-start, `lastAssistantMessageIsCompleteWithApprovalResponses`.
- `web/src/components/chat/ChatMessageItem.tsx`, `ToolPartRenderer.tsx`, `ChatMessageList.tsx`, `TodoProgress.tsx`, `ChatInputArea.tsx` — replace `isToolUIPart`/`getToolName`/`UIMessage`/`LanguageModelUsage` imports from `ai` with local equivalents matching items shape.
- `web/src/components/chat/SyncInlineControls.tsx` and approval store — send approvals via `ws.send({type:"chat.approve",...})` instead of `postSyncVerdict()` HTTP.
- `web/src/hooks/use-realtime.ts`, `web/src/stores/realtime.ts` — fan new `chat.*` events into the chat store / `useWsChat` reducer.
- `web/src/pages/ProjectPage.tsx` and `web/src/components/chat/...` — stop fetching `/messages` for hydration; rely on `chat.snapshot` after `viewChat`. (Keep the HTTP route for now if any non-WS consumer needs it; otherwise delete.)

**Verify (manual UI smoke — required because typecheck/test do not verify UX):**
- Send a message, see streaming text + tool parts.
- Stop mid-stream; assistant message persists with `output-error` parts.
- Reload mid-stream; snapshot restores in-flight state, deltas resume.
- Two-tab spectator: second tab sees same snapshot + live deltas.
- Approval (bash sync) round-trip via WS.
- Plan-mode `finishPlanning` triggers and renders.

### Phase 4 — Migration + cleanup
**Create:**
- `server/db/migrations/NNNN_messages_to_items_shape.sql` (or scripted) — convert existing `messages` rows from `UIMessage` JSON to items JSON via `legacyUiMessageToItems()`. Convert any active-stream checkpoints similarly (or invalidate on deploy).

**Modify / Delete:**
- `package.json` — remove `ai`, `@ai-sdk/react`, `@ai-sdk/provider`, `@ai-sdk/provider-utils`, `@ai-sdk/openai`, `@openrouter/ai-sdk-provider`, `resumable-stream`. Add `@openrouter/sdk`, `zod-to-json-schema` (if needed).
- Grep `from "ai"` and `from "@ai-sdk/` — must be zero matches before merge.
- `server/routes/messages.ts` — keep only if needed for non-WS consumers (Telegram web view, etc.); otherwise delete.

**Verify:** `tsc --noEmit` (server + web) clean; full vitest; manual run-through of: web chat, autonomous scheduler, Telegram chat, sub-agent spawner, plan mode, image generation, embeddings/RAG retrieval.

## Critical files

- `server/lib/agent/agent.ts` — replace `ToolLoopAgent`.
- `server/lib/agent-step/index.ts` — replace SSE response building with WS publishing.
- `server/lib/conversation/compact-conversation.ts` — `prepareStep` rewired to canonical types.
- `server/lib/http/ws.ts` — extend message handlers.
- `server/lib/sync-approval.ts` — invert approval round-trip.
- `web/src/components/chat/ChatPanel.tsx` — replace `useChat` with `useWsChat`.
- `web/src/components/chat/ToolPartRenderer.tsx`, `ChatMessageItem.tsx`, `ChatMessageList.tsx` — drop AI SDK imports, adopt items shape.
- `server/lib/media/image.ts` — direct OpenRouter HTTP.
- `server/lib/search/vectors.ts` — adapter embeddings.

## Risks

- **R1 — Provider SDK shape unknown.** All translation risk lives in `openrouter/client.ts` + `messages/converters.ts`. Mitigate with Spike A before Phase 1.
- **R2 — Anthropic prompt-cache passthrough.** `cacheControl: ephemeral` is currently set on instructions. If OpenRouter SDK doesn't expose provider passthrough cleanly, cache hit-rate drops silently. Verify in Spike A.
- **R3 — Compaction structured output.** Today uses AI SDK structured outputs / zod. If `@openrouter/sdk` lacks an equivalent, fall back to JSON-mode prompt + `zod.parse`.
- **R4 — Items-shape migration.** Persisted UIMessage JSON must be converted; any failure leaves chats unrenderable. Mitigate with a migration test against a snapshot of production rows + a dry-run that logs unconvertible messages.
- **R5 — Approval logic moves server-side.** Client no longer auto-resubmits on `lastAssistantMessageIsCompleteWithApprovalResponses`; server detects "all approvals in" and resumes the loop. This is an inversion that needs explicit testing in autonomous + interactive modes.
- **R6 — Big-bang means no incremental signal.** The branch will be unmergeable until every phase is done. Long-lived rebases against `main` are likely; minimize `main` churn in touched files for the duration.
- **R7 — `@openrouter/sdk` is beta** with breaking changes between minors. Pin the version, watch their changelog.

## End-to-end verification

1. **Spike outputs.** Spikes A/B/C must each produce a 1-page note answering their open questions before Phase 1 starts.
2. **Server unit + integration.** Vitest green. New tests: `loop.test.ts` (tool execution + stop conditions), `chat-bus.test.ts` (snapshot + delta ordering), `ws-chat.test.ts` (headless WS round-trip), `legacyUiMessageToItems.test.ts` (round-trip on captured fixtures).
3. **Manual UI smoke** (per Phase 3 list — required, not skippable).
4. **Cross-path regression.** Telegram chat, autonomous scheduler tick, sub-agent spawner inside web chat, plan mode end-to-end.
5. **Final grep gate.** `rg 'from "ai"|from "@ai-sdk/'` must return zero hits before merge.
