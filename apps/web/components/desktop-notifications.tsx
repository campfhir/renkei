'use client';

import { useEffect, useRef } from 'react';
import { useNotifications } from '@/components/notification-center';

/**
 * Native browser notifications — the OS banner, not the corner toast.
 *
 * Mounted only when the preference is on, and firing only while this tab is
 * NOT in front: the toast stack owns the foreground, and an OS banner about
 * a page somebody is already looking at says the same thing twice. It reads
 * the same arrivals the toasts do, so it costs no extra request — the one
 * poller gains a third reader.
 *
 * The preference is the person's half of the deal; `Notification.permission`
 * is the browser's, per origin, and it is re-checked at FIRE time rather
 * than trusted from mount. Permission can be revoked in site settings long
 * after the switch was saved, and the reverse — pref on, permission newly
 * granted in another tab — should start working without a save.
 *
 * Banners are tagged the way the toast pile coalesces: repeats of one tool
 * in one run REPLACE each other, so a loop transitioning forty issues is
 * one banner that updates, not forty stacked ones.
 *
 * Some browsers — Chrome on Android chief among them — refuse the plain
 * `new Notification()` constructor outright and only display anything
 * through an active service worker's `showNotification()`. This component
 * registers `/sw.js` (a click-routing worker, no push, no caching) up
 * front so that path is ready by the time a banner needs it, and falls
 * back to it only when the constructor throws — every browser where the
 * constructor already works keeps using it unchanged.
 */
export default function DesktopNotifications() {
  const { arrivals } = useNotifications();
  // Ids already announced. Arrivals linger in context until their toast is
  // dismissed (or forever, with toasts off), and an effect re-run must not
  // replay them as fresh banners.
  const announced = useRef(new Set<string>());

  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
    // Registration is cheap and idempotent — the browser no-ops a repeat
    // register() of the same URL/scope — so there is no reason to gate it
    // on the preference beyond this component only mounting when it's on.
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Nothing to recover: browsers that need this path simply keep
      // relying on the constructor, same as before this existed.
    });
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;

    // Front and focused means the corner has it covered. Arrivals that show
    // up while the check fails are still marked announced below — coming
    // back to the tab must not fire banners about what you just watched.
    const inFront = document.visibilityState === 'visible' && document.hasFocus();

    for (const entry of arrivals) {
      if (announced.current.has(entry.id)) continue;
      announced.current.add(entry.id);
      if (inFront) continue;

      const options: NotificationOptions = {
        body: entry.agentName ?? 'An agent',
        tag: entry.runId && entry.tool ? `${entry.runId}:${entry.tool}` : entry.id,
        icon: '/icon.svg',
        data: { refUrl: entry.refUrl },
      };
      try {
        const banner = new Notification(entry.headline, options);
        const refUrl = entry.refUrl;
        banner.onclick = () => {
          // Clicking brings Renkei back regardless; the linked thing — the
          // ticket that was filed, the message that was sent — opens beside
          // it, same as clicking the toast would have.
          window.focus();
          if (refUrl) window.open(refUrl, '_blank', 'noopener,noreferrer');
          banner.close();
        };
      } catch {
        // The constructor path is closed here — fall back to the worker,
        // which handles its own click routing (see public/sw.js).
        void showViaServiceWorker(entry.headline, options);
      }
    }
  }, [arrivals]);

  return null;
}

/** The worker-backed half of showing a banner — see the block comment above
 *  for why this exists alongside the constructor instead of replacing it. */
async function showViaServiceWorker(title: string, options: NotificationOptions) {
  if (!('serviceWorker' in navigator)) return;
  // A registration that hasn't finished activating yet can't show
  // anything; `getRegistration()` reflects that immediately instead of
  // hanging on `.ready`, which would wait for a worker that may never
  // arrive on a browser where none of this is supported.
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) return;
  try {
    await registration.showNotification(title, options);
  } catch {
    // Truly nothing left to try. The badge and the notifications page
    // still carry the news.
  }
}
