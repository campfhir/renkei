/**
 * The one bit "show system notifications" now boils down to, kept in this
 * browser's localStorage instead of the database.
 *
 * It used to be a synced `NotificationPrefs` field, but `Notification.
 * permission` is per-origin AND per-browser — a database row can't make a
 * phone's browser agree to something a laptop's browser granted, so syncing
 * "on" across devices was already claiming more than it could deliver. This
 * keeps the one thing that actually IS local, local.
 *
 * Scoped by tenant, matching the localStorage keys elsewhere in apps/web
 * (see notification-permission-nudge.tsx): one person can sign into more
 * than one tenant from the same browser, and each has its own answer.
 */
function storageKey(): string {
  return 'renkei:desktop-notifications-enabled';
}

export function getDesktopNotificationsEnabled(): boolean {
  try {
    return window.localStorage.getItem(storageKey()) === '1';
  } catch {
    // No storage, no memory of an earlier opt-in — off is the safe default.
    return false;
  }
}

export function setDesktopNotificationsEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(storageKey(), enabled ? '1' : '0');
  } catch {
    // The preference just won't stick in this browser.
  }
}
