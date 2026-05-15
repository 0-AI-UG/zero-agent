import { useEffect, useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { registerServiceWorker } from "@/lib/service-worker";
import { subscribeToPush, unsubscribeLocalDevice } from "@/lib/push";
import { apiFetch } from "@/api/client";

interface AccountPushStatus {
  subscribed: boolean;
  deviceCount: number;
}

/**
 * Account-level push state. `isSubscribed` reflects whether *any* of the
 * user's devices is subscribed (server-side count). Toggling on subscribes
 * the current device; toggling off purges every device's subscription
 * server-side and best-effort unsubscribes the local pushManager.
 */
export function usePushSubscription() {
  const qc = useQueryClient();
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null);
  const [actionPending, setActionPending] = useState(false);

  useEffect(() => {
    registerServiceWorker().then((reg) => setRegistration(reg));
  }, []);

  const status = useQuery({
    queryKey: ["push", "status"],
    queryFn: () => apiFetch<AccountPushStatus>("/push/status"),
    staleTime: 15_000,
  });

  const subscribe = useCallback(async () => {
    if (!registration) return false;
    setActionPending(true);
    try {
      const ok = await subscribeToPush(registration);
      if (ok) await qc.invalidateQueries({ queryKey: ["push", "status"] });
      return ok;
    } finally {
      setActionPending(false);
    }
  }, [registration, qc]);

  const unsubscribe = useCallback(async () => {
    setActionPending(true);
    try {
      await apiFetch("/push/all", { method: "DELETE" });
      // Best-effort: drop this device's local subscription so the next
      // toggle-on fetches a fresh one rather than reusing a now-orphaned record.
      if (registration) await unsubscribeLocalDevice(registration);
      await qc.invalidateQueries({ queryKey: ["push", "status"] });
    } finally {
      setActionPending(false);
    }
  }, [registration, qc]);

  const isSupported = "serviceWorker" in navigator && "PushManager" in window;

  return {
    isSubscribed: status.data?.subscribed ?? false,
    deviceCount: status.data?.deviceCount ?? 0,
    isLoading: status.isLoading || actionPending,
    isSupported,
    subscribe,
    unsubscribe,
  };
}
