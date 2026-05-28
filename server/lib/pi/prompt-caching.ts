/**
 * Enable Anthropic-style prompt caching on a Pi AgentSession.
 *
 * pi-ai's providers (anthropic-messages and openai-completions for
 * OpenRouter→Anthropic models) already know how to place cache_control
 * breakpoints on the system prompt, last tool definition, and last
 * conversation message — but only when `cacheRetention` is passed in
 * stream options. pi-coding-agent's createAgentSession doesn't surface
 * that option (see pi-mono#967), so we wrap the Agent's streamFn here.
 *
 * "short" → 5min ephemeral (Anthropic) / in-memory (OpenAI).
 * "long"  → 1h (Anthropic) / 24h (OpenAI). Costs ~25% more on cache write.
 */
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { type CacheRetention, streamSimple } from "@mariozechner/pi-ai";

export function enablePromptCaching(
  session: AgentSession,
  options: { retention?: CacheRetention; sessionId?: string } = {},
): void {
  const retention = options.retention ?? "short";
  if (options.sessionId) {
    session.agent.sessionId = options.sessionId;
  }
  const inner = session.agent.streamFn ?? streamSimple;
  session.agent.streamFn = (model, context, opts) =>
    inner(model, context, { ...opts, cacheRetention: retention });
}
