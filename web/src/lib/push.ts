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
  // Check existing subscription
  let sub = await registration.pushManager.getSubscription();
  if (sub) {
    // Re-send to server in case it was lost
    await sendSubscriptionToServer(sub);
    return true;
  }

  // Fetch VAPID key from server
  const { publicKey } = await apiFetch<{ publicKey: string }>("/push/vapid-key");

  // Request permission + subscribe
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return false;

  sub = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });

  await sendSubscriptionToServer(sub);
  return true;
}

export async function unsubscribeFromPush(
  registration: ServiceWorkerRegistration,
): Promise<void> {
  const sub = await registration.pushManager.getSubscription();
  if (!sub) return;

  await apiFetch("/push/subscribe", {
    method: "DELETE",
    body: JSON.stringify({ endpoint: sub.endpoint }),
  });
  await sub.unsubscribe();
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

export async function isPushSubscribed(
  registration: ServiceWorkerRegistration,
): Promise<boolean> {
  const sub = await registration.pushManager.getSubscription();
  return !!sub;
}
