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
// packages/notifications/src/send.ts (PushWirePayload) for the shape.
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
      // `quiet` (see @renkei/notifications' PushWirePayload) marks a push
      // that only repeats something already rendered inline on its own
      // page — a question or permission ask. For those, skip the banner
      // when that EXACT page is the one open and focused: the person is
      // already looking at it. Everything else (a ticket filed, a run
      // finishing) is news regardless of what tab is in front, so it
      // always shows. `WindowClient.focused`/`.visibilityState`/`.url` are
      // this worker's only way to ask, since a push can arrive with
      // nothing open at all.
      if (data.quiet && data.appUrl) {
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const alreadyOpen = windows.some((client) => {
          if (!(client.focused && client.visibilityState === 'visible')) return false;
          try {
            return new URL(client.url).pathname === data.appUrl;
          } catch {
            return false;
          }
        });
        if (alreadyOpen) return;
      }

      await self.registration.showNotification(data.title || 'Renkei', {
        body: data.body,
        tag: data.tag,
        icon: data.icon || '/icon.svg',
        // `openUrl` is where the click goes: the row's open route (which
        // marks it read and sends the browser on), or a plain page for a
        // push with no row behind it. `appUrl` alone is the older shape.
        data: {
          openUrl: data.openUrl || data.appUrl,
          external: data.external === true,
          appUrl: data.appUrl,
        },
      });
    })()
  );
});

// A banner shown via `registration.showNotification()` has no page-side
// `onclick` to attach to, so the click has to be handled here instead.
//
// Where it goes is decided server-side (the row's open route: mark the
// notification read, then the source application — a Jira issue, a WebEx
// space — when the person wants that, else the thing's place in Renkei).
// What this decides is only HOW: something outside Renkei opens in a new
// window and leaves the person's Renkei tab where it was; something inside
// Renkei brings that tab forward and takes it there, or opens one.
self.addEventListener('notificationclick', (event) => {
  const data = event.notification.data || {};
  const openUrl = data.openUrl || data.appUrl || '/';
  const fallback = data.appUrl || '/';
  event.notification.close();

  event.waitUntil(
    (async () => {
      if (data.external) {
        try {
          await self.clients.openWindow(openUrl);
          return;
        } catch {
          // A URL this browser refuses to open from a worker (a custom
          // scheme with nothing registered for it) — land in Renkei
          // instead, where the link is still one tap away.
        }
      }
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = windows.find((client) => 'focus' in client);
      const target = data.external ? fallback : openUrl;
      if (existing) {
        await existing.focus();
        try {
          await existing.navigate(target);
          return;
        } catch {
          // A window this worker does not control (matched as uncontrolled)
          // cannot be navigated from here; open the target beside it.
        }
      }
      await self.clients.openWindow(target);
    })()
  );
});
