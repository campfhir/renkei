/**
 * The client's half of turning "permission granted" into an actual push
 * subscription — the step that was missing before: granting
 * `Notification.permission` says a browser WILL show one if asked, but
 * asking requires `PushManager.subscribe()` and telling the server the
 * result, which is what this does.
 *
 * Deliberately separate from desktop-notifications-storage.ts: that file is
 * one flag this browser remembers about itself, synchronous and
 * dependency-free; this one talks to the network and the service worker,
 * and both the checkbox in Preferences and the corner nudge need the exact
 * same sequence, which is the point of pulling it out once.
 */

export type EnableOutcome = 'granted' | 'denied' | 'unsupported' | 'subscribe-failed';

function supportsPush(): boolean {
  return (
    typeof window !== 'undefined' &&
    'Notification' in window &&
    'serviceWorker' in navigator &&
    'PushManager' in window
  );
}

/** VAPID keys travel base64url; `applicationServerKey` wants raw bytes. */
function urlBase64ToUint8Array(base64url: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  // The explicit <ArrayBuffer> matters: applicationServerKey's
  // ArrayBufferView<ArrayBuffer> refuses the wider
  // Uint8Array<ArrayBufferLike> the plain constructor call would otherwise
  // infer (it excludes SharedArrayBuffer, which ArrayBufferLike allows).
  const bytes = new Uint8Array<ArrayBuffer>(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/**
 * Subscribes THIS browser and tells the server, assuming permission is
 * already granted. Safe to call opportunistically — `subscribe()` on an
 * already-subscribed device returns the existing subscription rather than
 * minting a new one, and the server upserts by endpoint either way.
 */
export async function ensurePushSubscription(tenantId: string): Promise<boolean> {
  if (!supportsPush() || Notification.permission !== 'granted') return false;

  try {
    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      const keyResponse = await fetch(`/api/tenant/${tenantId}/push/public-key`);
      if (!keyResponse.ok) return false;
      const body: unknown = await keyResponse.json();
      const publicKey =
        typeof body === 'object' && body !== null && 'publicKey' in body
          ? body.publicKey
          : undefined;
      if (typeof publicKey !== 'string') return false;

      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
    }

    const json = subscription.toJSON();
    if (typeof json.endpoint !== 'string' || !json.keys) return false;

    const saveResponse = await fetch(`/api/tenant/${tenantId}/push/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
    });
    return saveResponse.ok;
  } catch {
    return false;
  }
}

/**
 * The full opt-in: request permission (a user gesture, per browser rules —
 * callers must only invoke this from a click), then subscribe. Mirrors
 * `ensurePushSubscription` for the "already granted" half rather than
 * duplicating it.
 */
export async function enableDesktopNotifications(tenantId: string): Promise<EnableOutcome> {
  if (!supportsPush()) return 'unsupported';

  let permission = Notification.permission;
  if (permission === 'default') {
    try {
      permission = await Notification.requestPermission();
    } catch {
      permission = 'denied';
    }
  }
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'unsupported';

  const subscribed = await ensurePushSubscription(tenantId);
  return subscribed ? 'granted' : 'subscribe-failed';
}

/** Best-effort: unsubscribes this browser's device and tells the server,
 *  even if one half fails — a stale row just gets pruned on its next 404. */
export async function disableDesktopNotifications(tenantId: string): Promise<void> {
  if (!supportsPush()) return;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    if (!subscription) return;

    const endpoint = subscription.endpoint;
    await subscription.unsubscribe().catch(() => undefined);
    await fetch(`/api/tenant/${tenantId}/push/unsubscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint }),
    }).catch(() => undefined);
  } catch {
    // Nothing left to try — the localStorage flag going off is what
    // actually stops this browser from acting on arrivals either way.
  }
}
