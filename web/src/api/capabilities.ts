import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "./client";

export type UiTheme = "default" | "bw" | "sunset" | "compact" | "editorial";

export interface ServerCapabilities {
  serverDocker: boolean;
  theme?: UiTheme;
}

export function useServerCapabilities() {
  return useQuery({
    queryKey: ["capabilities"],
    queryFn: () => apiFetch<ServerCapabilities>("/capabilities"),
    staleTime: 60_000,
  });
}
