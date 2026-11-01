/**
 * The Access page's "Remove key" (shred-key-button.tsx): who it is
 * offered for, what the operator is asked (twice: in words, then by
 * typing the person's name), what the removal sends and what its answer
 * leaves on screen. The component shows the browser's confirm and prompt
 * and makes the call; tested in shred-key-button.model.test.ts.
 */

import { isRecord } from '@renkei/guards';

/**
 * Offered for anyone holding a key except the operator looking: their own
 * key is theirs to remove from Preferences (the route refuses it too).
 */
export function removeKeyOffered(
  personSubject: string,
  viewerSubject: string,
  holdsKey: boolean
): boolean {
  return holdsKey && personSubject !== viewerSubject;
}

export function confirmText(displayName: string): string {
  return `Remove ${displayName}'s encryption key? Their chats, connections and memory become unreadable to everyone, Renkei included, and nothing can bring them back. Chats they shared stay readable to the people they shared them with.`;
}

export function promptText(displayName: string): string {
  return `Type the person's name to confirm: ${displayName}`;
}

/** The second ask: the person's name, typed. Cancelling or a different name is a no. */
export function nameConfirmed(typed: string | null, displayName: string): boolean {
  return typed !== null && typed.trim() === displayName.trim();
}

export function removeKeyPath(subject: string): string {
  return `/api/admin/access/${encodeURIComponent(subject)}/keys`;
}

/** The DELETE's answer: removed only on a 2xx that says so; otherwise the server's reason. */
export function removalOutcome(
  ok: boolean,
  body: unknown
): { removed: true } | { removed: false; error: string } {
  const data = isRecord(body) ? body : {};
  if (ok && data.success === true) return { removed: true };
  return {
    removed: false,
    error: typeof data.error === 'string' ? data.error : 'Could not remove the key',
  };
}

export interface ShredState {
  busy: boolean;
  error: string | null;
}

export const initialShred: ShredState = { busy: false, error: null };

export type ShredAction =
  | { type: 'sent' }
  | { type: 'removed' }
  | { type: 'refused'; error: string }
  | { type: 'unreachable' };

export function shredReducer(state: ShredState, action: ShredAction): ShredState {
  switch (action.type) {
    case 'sent':
      return { busy: true, error: null };
    case 'removed':
      return { busy: false, error: null };
    case 'refused':
      return { busy: false, error: action.error };
    case 'unreachable':
      return { busy: false, error: 'Could not reach the server' };
  }
}

export function buttonLabel(state: ShredState): string {
  return state.busy ? 'Removing…' : 'Remove key';
}
