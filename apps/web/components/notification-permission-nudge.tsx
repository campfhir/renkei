'use client';

import { useEffect, useState } from 'react';
import { Icon, ICONS } from '@/components/icons';

/**
 * A corner toast nudging someone to finish turning on browser
 * notifications.
 *
 * `desktopEnabled` (the preference) and `Notification.permission` (the
 * browser's own, per-origin answer) can drift apart after the preference
 * form already brought them in sync once: permission can be reset to
 * "ask" or revoked to "denied" from the browser's own site settings at any
 * time, independent of anything Renkei does. When that happens the switch
 * in Preferences still reads on, but nothing will ever fire — this is the
 * nudge to notice and fix it from wherever that becomes relevant, not only
 * on the Preferences page itself.
 *
 * Mounted on the handful of pages someone is actually likely to care in
 * the moment — home, notifications, preferences — rather than globally:
 * this is a call to action, not an ambient status the whole app should
 * carry on every screen.
 *
 * `requestPermission()` only honours a user gesture, so the one thing this
 * can do unprompted is offer the button; it can never raise the browser's
 * own prompt on mount.
 *
 * Top-right, deliberately not the corner `ToastStack` and
 * `DesktopNotifications` use: those live at the bottom and are about
 * things that already happened, this is a standing action item, and the
 * two should never end up stacked on top of each other.
 */
function storageKey(tenantId: string): string {
  return `renkei:notification-nudge-dismissed:${tenantId}`;
}

export default function NotificationPermissionNudge({
  tenantId,
  desktopEnabled,
}: {
  tenantId: string;
  desktopEnabled: boolean;
}) {
  // Server-rendered first, where `Notification` does not exist — null until
  // the effect below reads the real answer, same reasoning as the switch
  // in preferences-form.tsx.
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported' | null>(
    null
  );
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!('Notification' in window)) {
      setPermission('unsupported');
      return;
    }
    setPermission(Notification.permission);
    try {
      setDismissed(window.localStorage.getItem(storageKey(tenantId)) === '1');
    } catch {
      // No storage, no memory of a prior dismissal — it shows again, which
      // is the safe direction to fail in.
    }
  }, [tenantId]);

  function dismiss() {
    setDismissed(true);
    try {
      window.localStorage.setItem(storageKey(tenantId), '1');
    } catch {
      // Nothing to persist; it will just show again on the next page.
    }
  }

  async function enable() {
    let current: NotificationPermission = Notification.permission;
    if (current === 'default') {
      try {
        current = await Notification.requestPermission();
      } catch {
        current = 'denied';
      }
    }
    setPermission(current);
    if (current === 'granted') dismiss();
  }

  if (
    !desktopEnabled ||
    dismissed ||
    permission === null ||
    permission === 'unsupported' ||
    permission === 'granted'
  ) {
    return null;
  }

  return (
    <div className="pointer-events-auto fixed right-4 top-4 z-30 w-[22rem] max-w-[calc(100vw-2rem)]">
      <article className="rounded-lg border border-gray-200 bg-white p-3 shadow-lg dark:border-gray-700 dark:bg-gray-950">
        <div className="flex items-start gap-2">
          <span className="mt-0.5 shrink-0 text-gray-400">
            <Icon path={ICONS.bell} className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">
              {permission === 'denied'
                ? 'Browser notifications are blocked'
                : 'Finish turning on browser notifications'}
            </p>
            <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
              {permission === 'denied'
                ? "You turned this on in Preferences, but this browser has it blocked for Renkei. Allow it in your browser's site settings, then reload."
                : 'You turned this on in Preferences, but your browser still hasn’t asked. Allow it to get the system banner while a tab is in the background.'}
            </p>
            {permission === 'default' ? (
              <button
                type="button"
                onClick={() => void enable()}
                className="mt-2 rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700"
              >
                Allow notifications
              </button>
            ) : null}
          </div>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={dismiss}
            className="relative shrink-0 rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800"
          >
            <Icon path={ICONS.close} className="h-3.5 w-3.5" />
          </button>
        </div>
      </article>
    </div>
  );
}
