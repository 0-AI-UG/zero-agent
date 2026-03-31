import { useQueryClient } from "@tanstack/react-query";
import type { SetupStatus } from "@/api/setup";

export function useDesktopMode(): boolean {
  const queryClient = useQueryClient();
  const data = queryClient.getQueryData<SetupStatus>(["setup", "status"]);
  return data?.desktopMode ?? false;
}
