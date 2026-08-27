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
 */
export default function DesktopNotifications() {
  const { arrivals } = useNotifications();
  // Ids already announced. Arrivals linger in context until their toast is
  // dismissed (or forever, with toasts off), and an effect re-run must not
  // replay them as fresh banners.
  const announced = useRef(new Set<string>());

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
      try {
        const banner = new Notification(entry.headline, {
          body: entry.agentName ?? 'An agent',
          tag: entry.runId && entry.tool ? `${entry.runId}:${entry.tool}` : entry.id,
          icon: '/icon.svg',
        });
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
        // Chrome on Android only shows notifications through a service
        // worker and throws on this constructor. Nothing to recover: the
        // badge and the notifications page still carry the news.
      }
    }
  }, [arrivals]);

  return null;
}
