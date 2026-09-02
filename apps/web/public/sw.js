// Service worker for real Web Push — the piece that lets an OS banner show
// up with NO tab open and no polling running, iOS included. The old design
// (a page polling for arrivals and locally constructing a Notification)
// only ever worked while a tab's JS was alive; this worker wakes on its own
// when the browser's push service delivers a message, whether or not
// anything Renkei-related is open.
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

// The payload is whatever @renkei/notifications' sendPush encoded — see
// packages/notifications/src/send.ts for the shape.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // A push with no body, or one that isn't JSON — nothing to show.
    return;
  }

  event.waitUntil(
    (async () => {
      // The same rule the old page-side code enforced with
      // document.hasFocus(): a tab already looking at Renkei has the
      // in-page toast covering this, so a second banner would just repeat
      // it. `WindowClient.focused`/`.visibilityState` are this worker's
      // only way to ask, since a push can arrive with nothing open at all.
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const inFront = windows.some(
        (client) => client.focused && client.visibilityState === 'visible'
      );
      if (inFront) return;

      await self.registration.showNotification(data.title || 'Renkei', {
        body: data.body,
        tag: data.tag,
        icon: data.icon || '/icon.svg',
        data: { appUrl: data.appUrl },
      });
    })()
  );
});

// A banner shown via `registration.showNotification()` has no page-side
// `onclick` to attach to, so the click has to be handled here instead:
// bring an existing tab forward, or open one, on Renkei's own notifications
// page — never the connector's own link (a Jira issue, a WebEx space…).
// That link is still one tap away from the notifications list itself; the
// OS banner's job is to bring you back to Renkei, not out to whichever
// connector an agent happened to touch.
self.addEventListener('notificationclick', (event) => {
  const appUrl = (event.notification.data && event.notification.data.appUrl) || '/';
  event.notification.close();

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = windows.find((client) => 'focus' in client);
      if (existing) {
        await existing.focus();
        await existing.navigate(appUrl);
      } else {
        await self.clients.openWindow(appUrl);
      }
    })()
  );
});
