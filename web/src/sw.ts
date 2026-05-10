/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

self.addEventListener("push", (event) => {
  const data = event.data?.json() ?? { title: "Zero Agent", body: "New notification" };
  const notifData: Record<string, unknown> = {
    url: data.url ?? "/",
    kind: data.kind,
  };
  event.waitUntil(
    self.registration.showNotification(data.title ?? "Zero Agent", {
      body: data.body,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag: data.tag ?? "default",
      data: notifData,
    } as NotificationOptions),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data ?? {};
  const url = data.url ?? "/";
  event.waitUntil(openOrFocus(url));
});

async function openOrFocus(url: string): Promise<void> {
  const clients = await self.clients.matchAll({ type: "window" });
  for (const client of clients) {
    if (client.url.includes(url) && "focus" in client) {
      await client.focus();
      return;
    }
  }
  await self.clients.openWindow(url);
}
