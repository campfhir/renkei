/**
 * The browser's hook for "this person's preferences just changed somewhere
 * other than the form that shows them": the chat's model changing them on
 * the person's word (renkei_set_preferences — the thread hears the turn's
 * `preferences_changed` event and announces it here), or a save in another
 * tab of the same browser.
 *
 * Whatever renders from a preference subscribes and re-reads its own part:
 * the shell re-renders the server's copy (PreferencesSync — the theme and
 * the line-number gutter ride on that), the thread its voice settings, the
 * tools dialog its defaults. What each of them does with a change is
 * app/(app)/preferences-sync.model.ts's.
 *
 * Module state for this tab — the announcer and the listeners share this
 * one module instance — and one BroadcastChannel for the others, the same
 * split lib/theme.ts makes with the `storage` event.
 */

export interface PreferencesChange {
  /** The documents that moved, as PATCH /api/preferences names them, plus 'defaultTools'. */
  documents: string[];
}

const CHANNEL = 'renkei:preferences';

const listeners = new Set<(change: PreferencesChange) => void>();

/**
 * This tab's one channel, opened when first needed. A BroadcastChannel
 * hears every OTHER channel object of its name — another tab's, but also a
 * second one in this same page — so the tab posts and listens on a single
 * object: its own announcement reaches this tab's listeners once, directly,
 * and other tabs' through the channel.
 */
let channel: BroadcastChannel | null | undefined;

function changeOf(data: unknown): PreferencesChange | null {
  if (typeof data !== 'object' || data === null || !('documents' in data)) return null;
  const documents: unknown = data.documents;
  if (!Array.isArray(documents)) return null;
  return { documents: documents.filter((name): name is string => typeof name === 'string') };
}

function tell(change: PreferencesChange): void {
  for (const listener of listeners) listener(change);
}

function tabChannel(): BroadcastChannel | null {
  if (channel !== undefined) return channel;
  try {
    channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL);
  } catch {
    channel = null;
  }
  if (channel) {
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const change = changeOf(event.data);
      if (change) tell(change);
    };
  }
  return channel;
}

/** Tell this tab's listeners, and every other tab's, that these documents changed. */
export function announcePreferencesChanged(change: PreferencesChange): void {
  if (change.documents.length === 0) return;
  tell(change);
  tabChannel()?.postMessage(change);
}

/**
 * Calls `onChange` whenever preferences change outside the caller's own
 * form, in this tab or another. Returns the unsubscribe.
 */
export function subscribePreferencesChanged(
  onChange: (change: PreferencesChange) => void
): () => void {
  listeners.add(onChange);
  // Opened here, not only on an announcement: a tab that never announces
  // still has to hear the others.
  tabChannel();
  return () => {
    listeners.delete(onChange);
  };
}
