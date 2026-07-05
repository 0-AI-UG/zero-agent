import { useQuery } from "@tanstack/react-query";

export type ProviderCapability = "chat" | "embedding" | "image" | "vision";

export interface ModelProvider {
  id: string;
  displayName: string;
  envVar: string;
  capabilities: Record<ProviderCapability, boolean>;
  defaults: Partial<Record<ProviderCapability, string>>;
}

// Plain fetch (no auth headers): the endpoint is public because the pre-auth
// setup wizard renders the same provider list.
export function useModelProviders() {
  return useQuery({
    queryKey: ["providers"],
    queryFn: async () => {
      const res = await fetch("/api/providers");
      if (!res.ok) throw new Error("Failed to load providers");
      const body = (await res.json()) as { providers: ModelProvider[] };
      return body.providers;
    },
    staleTime: 5 * 60_000,
  });
}
