/**
 * Singleton `OpenRouter` SDK client.
 *
 * Reads the API key from the settings store (matches current behavior in
 * `server/lib/providers/openrouter.ts`). Re-creates the client when the key
 * changes so settings-page updates take effect without a restart.
 *
 * Phase 1 builds the higher-level helpers (streamAgentTurn, generateText,
 * embed, generateImage) on top of this client.
 */

import { OpenRouter } from "@openrouter/sdk";
import { getSetting } from "@/lib/settings.ts";
import { log } from "@/lib/utils/logger.ts";

const orLog = log.child({ module: "openrouter-client" });

let _cachedKey: string | null = null;
let _cachedClient: OpenRouter | null = null;

export function getOpenRouterClient(): OpenRouter {
  const key = getSetting("OPENROUTER_API_KEY") ?? process.env.OPENROUTER_API_KEY ?? "";
  if (_cachedClient && key === _cachedKey) return _cachedClient;
  _cachedKey = key;
  _cachedClient = new OpenRouter({
    apiKey: key,
  });
  orLog.info("openrouter client (re)created", { hasKey: !!key });
  return _cachedClient;
}
