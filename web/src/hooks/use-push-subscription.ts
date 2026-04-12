import { useState, useEffect, useCallback } from "react";
import { registerServiceWorker } from "@/lib/service-worker";
import { subscribeToPush, unsubscribeFromPush, isPushSubscribed } from "@/lib/push";

export function usePushSubscription() {
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null);

  useEffect(() => {
    registerServiceWorker().then((reg) => {
      if (!reg) {
        setIsLoading(false);
        return;
      }
      setRegistration(reg);
      isPushSubscribed(reg).then((subscribed) => {
        setIsSubscribed(subscribed);
        setIsLoading(false);
      });
    });
  }, []);

  const subscribe = useCallback(async () => {
    if (!registration) return false;
    setIsLoading(true);
    try {
      const success = await subscribeToPush(registration);
      setIsSubscribed(success);
      return success;
    } finally {
      setIsLoading(false);
    }
  }, [registration]);

  const unsubscribe = useCallback(async () => {
    if (!registration) return;
    setIsLoading(true);
    try {
      await unsubscribeFromPush(registration);
      setIsSubscribed(false);
    } finally {
      setIsLoading(false);
    }
  }, [registration]);

  const isSupported = "serviceWorker" in navigator && "PushManager" in window;

  return { isSubscribed, isLoading, isSupported, subscribe, unsubscribe };
}
