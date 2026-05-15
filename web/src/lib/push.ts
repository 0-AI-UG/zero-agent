import { apiFetch } from "@/api/client";

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const arr = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) arr[i] = rawData.charCodeAt(i);
  return arr;
}

export async function subscribeToPush(
  registration: ServiceWorkerRegistration,
): Promise<boolean> {
  // Permission MUST be requested as a direct response to the user gesture on
  // iOS Safari/PWA — no awaited network calls before this.
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return false;

  // pushManager.subscribe needs an active SW; on iOS, subscribing against an
  // installing registration fails silently.
  const activeReg = await navigator.serviceWorker.ready;

  let sub = await activeReg.pushManager.getSubscription();
  if (sub) {
    await sendSubscriptionToServer(sub);
    return true;
  }

  const { publicKey } = await apiFetch<{ publicKey: string }>("/push/vapid-key");

  sub = await activeReg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });

  await sendSubscriptionToServer(sub);
  return true;
}

/**
 * Drop only this device's `pushManager` subscription. The server-side row is
 * removed elsewhere (e.g. account-wide purge via `DELETE /push/all`).
 */
export async function unsubscribeLocalDevice(
  registration: ServiceWorkerRegistration,
): Promise<void> {
  const sub = await registration.pushManager.getSubscription();
  if (!sub) return;
  try { await sub.unsubscribe(); } catch { /* best-effort */ }
}

async function sendSubscriptionToServer(sub: PushSubscription): Promise<void> {
  const json = sub.toJSON();
  await apiFetch("/push/subscribe", {
    method: "POST",
    body: JSON.stringify({
      endpoint: sub.endpoint,
      p256dh: json.keys!.p256dh,
      auth: json.keys!.auth,
    }),
  });
}
