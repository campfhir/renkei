'use client';

import { useEffect, useState } from 'react';
import { Icon, ICONS } from '@/components/icons';
import { getDesktopNotificationsEnabled } from '@/lib/desktop-notifications-storage';

/**
 * A card in the same corner pile as the arrival toasts, nudging someone to
 * finish turning on browser notifications — not a floating box of its own.
 * Rendered from `NotificationCorner` alongside `ToastStack`, `flex-col-
 * reverse`d so it sits UNDER whatever arrival toasts are showing, closest to
 * the screen edge: a standing action item, not something competing with the
 * more urgent, more recent things in the pile.
 *
 * The opt-in (kept in this browser's localStorage, see
 * desktop-notifications-storage.ts) and `Notification.permission` (the
 * browser's own, per-origin answer) can drift apart after the checkbox in
 * Preferences last brought them in sync: permission can be reset to "ask"
 * or revoked to "denied" from the browser's own site settings at any time,
 * independent of anything Renkei does. When that happens the switch in
 * Preferences still reads on, but nothing will ever fire — this is the
 * nudge to notice and fix it from wherever that becomes relevant, not only
 * on the Preferences page.
 *
 * `requestPermission()` only honours a user gesture, so the one thing this
 * can do unprompted is offer the button; it can never raise the browser's
 * own prompt on mount.
 */
function dismissKey(tenantId: string): string {
  return `renkei:notification-nudge-dismissed:${tenantId}`;
}

export default function NotificationPermissionNudge({ tenantId }: { tenantId: string }) {
  // Server-rendered first, where `Notification` does not exist — null until
  // the effect below reads the real answer, same reasoning as the switch
  // in preferences-form.tsx.
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported' | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setEnabled(getDesktopNotificationsEnabled(tenantId));
    if (!('Notification' in window)) {
      setPermission('unsupported');
      return;
    }
    setPermission(Notification.permission);
    try {
      setDismissed(window.localStorage.getItem(dismissKey(tenantId)) === '1');
    } catch {
      // No storage, no memory of a prior dismissal — it shows again, which
      // is the safe direction to fail in.
    }
  }, [tenantId]);

  function dismiss() {
    setDismissed(true);
    try {
      window.localStorage.setItem(dismissKey(tenantId), '1');
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
    !enabled ||
    dismissed ||
    permission === null ||
    permission === 'unsupported' ||
    permission === 'granted'
  ) {
    return null;
  }

  return (
    <article className="pointer-events-auto w-full rounded-lg border border-gray-200 bg-white p-3 shadow-lg dark:border-gray-700 dark:bg-gray-950">
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
  );
}
