/**
 * The confirm-then-disconnect control at the foot of every OAuth connect
 * card (disconnect-control.tsx): Disconnect asks first, "Keep it" backs
 * out without a call, "Yes, disconnect" sends the DELETE, and a refusal
 * stays under the buttons in the server's own words. Pure; tested in
 * disconnect-control.model.test.ts.
 */

import { recordOrNull } from '@renkei/guards';

export interface DisconnectState {
  confirming: boolean;
  busy: boolean;
  notice: string | null;
}

export type DisconnectAction =
  | { type: 'asked' }
  | { type: 'kept' }
  | { type: 'sent' }
  | { type: 'disconnected' }
  | { type: 'failed'; notice: string };

export const initialDisconnectState: DisconnectState = {
  confirming: false,
  busy: false,
  notice: null,
};

export function disconnectReducer(
  state: DisconnectState,
  action: DisconnectAction
): DisconnectState {
  switch (action.type) {
    case 'asked':
      return { ...state, confirming: true };
    case 'kept':
      return { ...state, confirming: false };
    case 'sent':
      return { ...state, busy: true, notice: null };
    case 'disconnected':
      return { ...state, busy: false, confirming: false };
    case 'failed':
      return { ...state, busy: false, notice: action.notice };
  }
}

/** The confirm button's words while the DELETE is out, and before. */
export function confirmLabel(state: DisconnectState): string {
  return state.busy ? 'Disconnecting…' : 'Yes, disconnect';
}

/**
 * What a refused DELETE leaves on screen: the first non-empty string among
 * the body's `errorFields`, in order, or "Could not disconnect".
 */
export function disconnectRefusal(body: unknown, errorFields: readonly string[]): string {
  const record = recordOrNull(body) ?? {};
  return (
    errorFields
      .map((field) => record[field])
      .find((value): value is string => typeof value === 'string' && value.length > 0) ??
    'Could not disconnect'
  );
}

/** What an unreachable server leaves on screen. */
export const UNREACHABLE = 'Could not reach the server';
