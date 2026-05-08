/**
 * Resolve a Zero model id (or fall back to the active provider's default
 * chat model) into the (model, authStorage) pair `runTurn` needs.
 *
 * v1 only knows OpenRouter — Pi has its own ModelRegistry but for the
 * cutover we keep the same key-management story Zero already has and
 * just hand Pi the OpenRouter key per turn. Multi-provider per-tenant
 * auth is open question §9; revisit when Pi sessions go multi-tenant.
 */
import { AuthStorage } from "@mariozechner/pi-coding-agent";
import { getModel, type Api, type Model } from "@mariozechner/pi-ai";
import { getSetting } from "@/lib/settings.ts";
import { getActiveProvider, resolveChatModelId } from "@/lib/providers/index.ts";

export interface ResolvedModel {
  model: Model<Api>;
  authStorage: AuthStorage;
}

let _cachedAuth: AuthStorage | null = null;
let _cachedKey: string | null = null;

function getOrBuildAuthStorage(): AuthStorage {
  const key =
    getSetting("OPENROUTER_API_KEY") ?? process.env.OPENROUTER_API_KEY ?? "";
  if (_cachedAuth && key === _cachedKey) return _cachedAuth;
  _cachedKey = key;
  _cachedAuth = AuthStorage.inMemory();
  if (key) _cachedAuth.setRuntimeApiKey("openrouter", key);
  if (process.env.ANTHROPIC_API_KEY) {
    _cachedAuth.setRuntimeApiKey("anthropic", process.env.ANTHROPIC_API_KEY);
  }
  return _cachedAuth;
}

/**
 * Resolve a Zero model id (or `undefined` to use the active provider's
 * default) into a Pi `(model, authStorage)` pair.
 */
export function resolveModelForPi(modelId?: string): ResolvedModel {
  const id = modelId
    ? resolveChatModelId(modelId)
    : getActiveProvider().getDefaultChatModelId();
  const model = getModel("openrouter", id as never) as Model<Api> | null;
  if (!model) {
    throw new Error(`unknown model: ${id}`);
  }
  return { model, authStorage: getOrBuildAuthStorage() };
}
