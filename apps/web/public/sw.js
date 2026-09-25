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

// Shared origin storage with the page (push-subscription.ts's
// rememberTenantForPush) — a worker woken only for `pushsubscriptionchange`
// has no page open to ask, so the tenant id has to already be sitting
// somewhere this worker can read.
const PUSH_DB_NAME = 'renkei-push';
const PUSH_DB_STORE = 'config';

function idbGetTenantId() {
  return new Promise((resolve) => {
    const openRequest = indexedDB.open(PUSH_DB_NAME, 1);
    openRequest.onupgradeneeded = () => openRequest.result.createObjectStore(PUSH_DB_STORE);
    openRequest.onerror = () => resolve(null);
    openRequest.onsuccess = () => {
      const db = openRequest.result;
      const getRequest = db
        .transaction(PUSH_DB_STORE, 'readonly')
        .objectStore(PUSH_DB_STORE)
        .get('tenantId');
      getRequest.onerror = () => resolve(null);
      getRequest.onsuccess = () => resolve(getRequest.result || null);
    };
  });
}

/** VAPID keys travel base64url; `applicationServerKey` wants raw bytes — same
 *  decode as push-subscription.ts's urlBase64ToUint8Array. */
function urlBase64ToUint8Array(base64url) {
  const padding = '='.repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

// A browser can silently rotate or drop a subscription on its own (iOS in
// particular churns these more than desktop browsers) — without this, the
// only recovery was DesktopNotifications' mount-time `ensurePushSubscription`
// call, which only runs if and when the PWA is next opened. This lets a
// worker that is woken for exactly this event recover immediately instead.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const tenantId = await idbGetTenantId();
      if (!tenantId) return;

      // Reuse the key the old subscription was minted with when the browser
      // still has it; only fall back to the tenant's public-key endpoint
      // (an extra round trip, and one more thing that can fail) when it doesn't.
      let applicationServerKey =
        event.oldSubscription && event.oldSubscription.options
          ? event.oldSubscription.options.applicationServerKey
          : null;

      if (!applicationServerKey) {
        try {
          const keyResponse = await fetch(`/api/tenant/${tenantId}/push/public-key`);
          if (!keyResponse.ok) return;
          const body = await keyResponse.json();
          if (typeof body.publicKey !== 'string') return;
          applicationServerKey = urlBase64ToUint8Array(body.publicKey);
        } catch {
          return;
        }
      }

      let subscription;
      try {
        subscription = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey,
        });
      } catch {
        // Nothing left to try from inside the worker — the app's own
        // mount-time check is the remaining fallback.
        return;
      }

      const json = subscription.toJSON();
      if (typeof json.endpoint !== 'string' || !json.keys) return;

      await fetch(`/api/tenant/${tenantId}/push/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
      }).catch(() => undefined);
    })()
  );
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
      // when that EXACT page is the one on screen: the person is already
      // looking at it. Everything else (a ticket filed, a run finishing)
      // is news regardless of what tab is in front, so it always shows.
      // `.visibilityState`/`.url` are this worker's only way to ask, since
      // a push can arrive with nothing open at all.
      //
      // Deliberately not also requiring `client.focused`: on iOS Safari a
      // PWA window's `WindowClient.focused` does not reliably read `true`
      // even while that exact window is the one in front and on screen, so
      // ANDing it in here left the banner firing every single time on iOS
      // — the bug this comment used to describe. Desktop browsers report
      // it fine, but `visibilityState` alone already answers the question
      // this check cares about (is the page on screen right now) without
      // that platform gap.
      if (data.quiet && data.appUrl) {
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const alreadyOpen = windows.some((client) => {
          if (client.visibilityState !== 'visible') return false;
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
