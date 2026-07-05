import { getSetting } from "@/lib/settings.ts";

/**
 * Cache an SDK client instance, recreating it when the API key setting
 * changes so settings-page updates take effect without a restart.
 */
export function cachedClient<T>(settingKey: string, create: (apiKey: string) => T): () => T {
  let cachedKey: string | null = null;
  let cached: T | null = null;
  return () => {
    const key = getSetting(settingKey) ?? "";
    if (cached !== null && key === cachedKey) return cached;
    cachedKey = key;
    cached = create(key);
    return cached;
  };
}
