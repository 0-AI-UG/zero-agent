/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

self.addEventListener("push", (event) => {
  let data: any = { title: "Zero Agent", body: "New notification" };
  try {
    if (event.data) data = event.data.json();
  } catch {
    try {
      const text = event.data?.text();
      if (text) data = { title: "Zero Agent", body: text };
    } catch {}
  }
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
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  // If a window is already open, focus it and navigate. openWindow is
  // unreliable when the PWA is already running (popup blockers, single-window
  // PWAs) — navigating an existing client always lands on the right page.
  for (const client of clients) {
    if ("focus" in client) {
      try {
        if ("navigate" in client) await (client as WindowClient).navigate(url);
      } catch { /* cross-origin or unsupported — fall back to focus only */ }
      await client.focus();
      return;
    }
  }
  await self.clients.openWindow(url);
}
