import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "./client";

export interface ServerCapabilities {
  serverDocker: boolean;
}

export function useServerCapabilities() {
  return useQuery({
    queryKey: ["capabilities"],
    queryFn: () => apiFetch<ServerCapabilities>("/capabilities"),
    staleTime: 60_000,
  });
}
