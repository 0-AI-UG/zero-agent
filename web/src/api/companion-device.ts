import { useMutation } from "@tanstack/react-query";
import { apiFetch } from "./client";

/**
 * Web side of the `zero login` device-authorization flow. The logged-in user
 * looks up a pending request by its short code, then approves it (minting a
 * project-scoped companion token) or denies it.
 */

export interface DeviceInfo {
  deviceName: string | null;
  status: "pending";
}

export function fetchDeviceInfo(userCode: string) {
  return apiFetch<DeviceInfo>(
    `/companion/device/info?userCode=${encodeURIComponent(userCode)}`,
  );
}

export function useApproveDevice() {
  return useMutation({
    mutationFn: (data: { userCode: string; projectId: string }) =>
      apiFetch<{ ok: true; projectName: string }>("/companion/device/approve", {
        method: "POST",
        body: JSON.stringify(data),
      }),
  });
}

export function useDenyDevice() {
  return useMutation({
    mutationFn: (userCode: string) =>
      apiFetch<{ ok: true }>("/companion/device/deny", {
        method: "POST",
        body: JSON.stringify({ userCode }),
      }),
  });
}
