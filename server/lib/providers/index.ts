import { getSetting } from "@/lib/settings.ts";
import { log } from "@/lib/utils/logger.ts";
import { getDefaultModel, getEnabledModels } from "@/db/queries/models.ts";
import { getProjectById } from "@/db/queries/projects.ts";
import type { Capability, InferenceProvider } from "@/lib/providers/types.ts";
import { openrouterProvider } from "@/lib/providers/openrouter.ts";
import { anthropicProvider } from "@/lib/providers/anthropic.ts";
import { openaiProvider } from "@/lib/providers/openai.ts";
import { googleProvider } from "@/lib/providers/google.ts";
import { compatibleProviders } from "@/lib/providers/openai-compatible.ts";

const provLog = log.child({ module: "providers" });

// ── Registry ──
// Every supported provider registers here on equal footing; ids share Pi's
// provider id space, so `pi_provider` on model rows resolves against this
// same registry. List order only matters as the auto-pick order when no
// explicit *_PROVIDER setting exists — openrouter stays first so pre-existing
// deployments (which only had an OpenRouter key) keep their behavior.
const ALL_PROVIDERS: InferenceProvider[] = [
  openrouterProvider,
  anthropicProvider,
  openaiProvider,
  googleProvider,
  ...compatibleProviders,
];

const PROVIDERS: Record<string, InferenceProvider> = Object.fromEntries(
  ALL_PROVIDERS.map((p) => [p.id, p]),
);

export function getProvider(id: string): InferenceProvider | undefined {
  return PROVIDERS[id];
}

export function getProviderOrThrow(id: string): InferenceProvider {
  const provider = PROVIDERS[id];
  if (!provider) throw new Error(`Unknown inference provider: ${id}`);
  return provider;
}

export function listProviders(): InferenceProvider[] {
  return ALL_PROVIDERS;
}

export function isProviderConfigured(provider: InferenceProvider): boolean {
  return !!getSetting(provider.apiKeySettingKey);
}

// ── Per-capability routing (embedding / image / vision) ──
// Chat is not routed here: agent turns and aux text generation resolve
// (provider, model) per model row via `resolveModelForPi`.

export type AuxCapability = Exclude<Capability, "chat">;

const ROUTE_SETTINGS: Record<AuxCapability, { provider: string; model: string }> = {
  embedding: { provider: "EMBEDDING_PROVIDER", model: "EMBEDDING_MODEL" },
  image: { provider: "IMAGE_PROVIDER", model: "IMAGE_MODEL" },
  vision: { provider: "VISION_PROVIDER", model: "VISION_MODEL" },
};

export interface CapabilityRoute {
  provider: InferenceProvider;
  modelId: string;
}

const warnedRoutes = new Set<string>();
function warnRouteOnce(key: string, message: string, ctx: Record<string, string>) {
  if (warnedRoutes.has(key)) return;
  warnedRoutes.add(key);
  provLog.warn(message, ctx);
}

/**
 * Provider serving a capability: the `*_PROVIDER` setting when valid,
 * otherwise the first capable provider with an API key configured,
 * otherwise the first capable provider.
 */
export function resolveCapabilityProvider(capability: AuxCapability): InferenceProvider | undefined {
  const settingKey = ROUTE_SETTINGS[capability].provider;
  const requested = getSetting(settingKey);
  if (requested) {
    const provider = PROVIDERS[requested];
    if (provider?.capabilities[capability]) return provider;
    warnRouteOnce(`${capability}:${requested}`, "configured provider cannot serve capability; auto-picking", {
      capability,
      setting: settingKey,
      requested,
    });
  }
  const capable = ALL_PROVIDERS.filter((p) => p.capabilities[capability]);
  return capable.find(isProviderConfigured) ?? capable[0];
}

export function getCapabilityRoute(capability: AuxCapability): CapabilityRoute {
  const provider = resolveCapabilityProvider(capability);
  if (!provider) throw new Error(`No provider supports ${capability}`);
  const modelId = getSetting(ROUTE_SETTINGS[capability].model) ?? provider.defaultModel(capability);
  if (!modelId) {
    throw new Error(
      `No ${capability} model configured for ${provider.displayName} — set ${ROUTE_SETTINGS[capability].model}`,
    );
  }
  return { provider, modelId };
}

/** True when the provider serving `capability` has an API key configured. */
export function isCapabilityConfigured(capability: AuxCapability): boolean {
  const provider = resolveCapabilityProvider(capability);
  return !!provider && isProviderConfigured(provider);
}

// ── Chat model resolution (models table) ──

/**
 * Default chat model id: admin-marked default in the `models` table → first
 * enabled model → a configured provider's built-in default.
 */
export function getDefaultChatModelId(): string {
  const dbDefault = getDefaultModel();
  if (dbDefault) return dbDefault.id;
  const firstEnabled = getEnabledModels()[0];
  if (firstEnabled) return firstEnabled.id;
  const withDefault = ALL_PROVIDERS.filter((p) => p.defaultModel("chat"));
  const provider = withDefault.find(isProviderConfigured) ?? withDefault[0];
  if (provider) return provider.defaultModel("chat")!;
  throw new Error("No chat model configured");
}

/**
 * Model used for `zero llm generate` — container scripts calling out via
 * the SDK/CLI proxy. Resolved in order: project `scripts_model` column →
 * default chat model.
 */
export function getScriptsModelId(projectId?: string): string {
  if (projectId) {
    const project = getProjectById(projectId);
    if (project?.scripts_model) return project.scripts_model;
  }
  return getDefaultChatModelId();
}

/**
 * Model used by scheduled tasks (cron, event, script triggers, "run now").
 * Resolved in order: project `tasks_model` column → default chat model.
 */
export function getTasksModelId(projectId?: string): string {
  if (projectId) {
    const project = getProjectById(projectId);
    if (project?.tasks_model) return project.tasks_model;
  }
  return getDefaultChatModelId();
}

export type { Capability, InferenceProvider };
