// Notification-only service worker — no push subscription, no caching.
//
// Its one job is `showNotification()`: some browsers (Chrome on Android
// chief among them) refuse the plain `new Notification()` constructor and
// require an active worker to display anything at all. Registering this
// lets `DesktopNotifications` (apps/web/components/desktop-notifications.tsx)
// fall back to a path that works there too, while still preferring the
// plain constructor where either would do.
//
// `skipWaiting`/`clients.claim` take it from "installed" to "controlling
// this page" without waiting for a reload — there is nothing here worth
// staging a version rollout for.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// A banner shown via `registration.showNotification()` has no page-side
// `onclick` to attach to, so the click has to be handled here instead —
// mirrors what DesktopNotifications does for the constructor path: bring an
// existing tab forward, or open one, then open the linked item beside it.
self.addEventListener('notificationclick', (event) => {
  const refUrl = event.notification.data && event.notification.data.refUrl;
  event.notification.close();

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = windows.find((client) => 'focus' in client);
      if (existing) {
        await existing.focus();
      } else {
        await self.clients.openWindow('/');
      }
      if (refUrl) {
        await self.clients.openWindow(refUrl);
      }
    })(),
  );
});
