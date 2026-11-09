/**
 * The run page's Cancel button. A queued run is canceled in the request
 * (it has not started), so the button says Canceled at once; a started run
 * stops at its next checkpoint, so it says Canceling… until the page's live
 * view shows the run canceled. A refusal says why and offers the button
 * again.
 */

export type CancelState =
  | { phase: 'idle'; error: string | null }
  | { phase: 'busy' }
  | { phase: 'canceling' }
  | { phase: 'canceled' };

export type CancelAction =
  | { type: 'press' }
  /** `canceled`: the route canceled it outright (it was queued). */
  | { type: 'answered'; canceled: boolean }
  | { type: 'refused'; error: string };

export const initialCancelState: CancelState = { phase: 'idle', error: null };

export function cancelReducer(state: CancelState, action: CancelAction): CancelState {
  switch (action.type) {
    case 'press':
      return state.phase === 'idle' ? { phase: 'busy' } : state;
    case 'answered':
      return state.phase === 'busy' ? { phase: action.canceled ? 'canceled' : 'canceling' } : state;
    case 'refused':
      return state.phase === 'busy' ? { phase: 'idle', error: action.error } : state;
  }
}

/** The button's words. */
export function cancelLabel(state: CancelState): string {
  switch (state.phase) {
    case 'idle':
      return '✕ Cancel run';
    case 'canceled':
      return 'Canceled';
    default:
      return 'Canceling…';
  }
}

/** Whether a press can go out now. */
export function canPress(state: CancelState): boolean {
  return state.phase === 'idle';
}
