'use client';

import { useEffect } from 'react';
import { getDesktopNotificationsEnabled } from '@/lib/desktop-notifications-storage';
import { ensurePushSubscription } from '@/lib/push-subscription';

/**
 * Native browser notifications — the OS banner, not the corner toast.
 *
 * Used to poll the same arrivals the toast pile does and locally construct
 * a `Notification` while a tab sat open-but-backgrounded. That path is
 * gone: it could only ever run while a tab's JavaScript was alive, which
 * iOS in particular stops within seconds of backgrounding a PWA — granted
 * permission, registered worker, and still nothing arrived, because
 * nothing was left running to notice. Showing the banner is now the
 * service worker's job, woken by a real push the server sends (see
 * `@renkei/notifications`' `sendPush` and `public/sw.js`'s `push` handler,
 * which also owns the "don't duplicate the in-page toast" check this used
 * to do with `document.hasFocus()` — the same rule, just evaluated from
 * the worker side since a push can arrive with no page open to ask).
 *
 * What's left here is registration and subscription upkeep: `/sw.js` has
 * to be registered before a push can ever be shown, and a subscription can
 * quietly go stale (a browser can drop it, storage can get cleared) without
 * `Notification.permission` or the opt-in flag knowing — this re-confirms
 * it on every mount rather than trusting whatever the last opt-in flow
 * left behind.
 */
export default function DesktopNotifications({ tenantId }: { tenantId: string }) {
  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
    // Registration is cheap and idempotent — the browser no-ops a repeat
    // register() of the same URL/scope — so there is no reason to gate it
    // on the preference: it costs nothing for someone who never opts in,
    // and it means the path is already warm for someone who opts in later.
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Nothing to recover: without a worker, push simply cannot show
      // anything in this browser.
    });
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (!getDesktopNotificationsEnabled(tenantId)) return;
    if (Notification.permission !== 'granted') return;
    // Silent — this never prompts (permission is already granted, so
    // requestPermission() would only ever no-op) and never touches the
    // opt-in flag either way; it only re-subscribes if the browser needs it.
    void ensurePushSubscription(tenantId);
  }, [tenantId]);

  return null;
}
