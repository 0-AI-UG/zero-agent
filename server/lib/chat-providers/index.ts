/**
 * Chat provider registry. Providers self-register at boot from
 * `server/index.ts`; consumers look them up by name.
 */
import type { ChatProvider, ChatProviderName } from "./types.ts";

const registry = new Map<ChatProviderName, ChatProvider>();

export function registerProvider(provider: ChatProvider): void {
  registry.set(provider.name, provider);
}

export function getProvider(name: ChatProviderName): ChatProvider | null {
  return registry.get(name) ?? null;
}

export function listAvailableProviders(): ChatProvider[] {
  return [...registry.values()].filter((p) => p.isAvailable());
}

export function listAllProviders(): ChatProvider[] {
  return [...registry.values()];
}

export type { ChatProvider, ChatProviderName } from "./types.ts";
export type {
  ProviderIncomingMessage,
  ProviderSendContent,
  ProviderSendResult,
  NotificationPayload,
  LinkCodeResult,
} from "./types.ts";
