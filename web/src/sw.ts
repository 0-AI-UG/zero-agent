/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

self.addEventListener("push", (event) => {
  const data = event.data?.json() ?? { title: "Zero Agent", body: "New notification" };
  // Pass through sync action metadata so notificationclick can dispatch.
  const notifData: Record<string, unknown> = {
    url: data.url ?? "/",
    kind: data.kind,
    syncId: data.syncId ?? data.payload?.syncId,
  };
  const isSyncApproval = data.kind === "sync_approval" && notifData.syncId;
  const actions = isSyncApproval
    ? [
        { action: "sync-approve", title: "Keep" },
        { action: "sync-reject", title: "Discard" },
      ]
    : undefined;
  event.waitUntil(
    self.registration.showNotification(data.title ?? "Zero Agent", {
      body: data.body,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag: data.tag ?? "default",
      data: notifData,
      ...(actions ? { actions } : {}),
    } as NotificationOptions),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data ?? {};

  // Sync approval action buttons - open the chat URL with an action hint
  // the page can pick up. We don't POST directly from the service worker
  // because auth tokens live in localStorage (not accessible here), so the
  // page handles the verdict once focused.
  if (event.action === "sync-approve" || event.action === "sync-reject") {
    const syncId = data.syncId;
    const baseUrl = data.url ?? "/";
    const verdict = event.action === "sync-approve" ? "approve" : "reject";
    const target = syncId
      ? `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}syncv=${encodeURIComponent(String(syncId))}:${verdict}`
      : baseUrl;
    event.waitUntil(openOrFocus(target));
    return;
  }

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
