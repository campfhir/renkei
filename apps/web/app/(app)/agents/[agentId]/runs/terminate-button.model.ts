/**
 * The Terminate button: stuck runs (queued or running for over two hours)
 * closed out directly, because a cancel never reaches them. It asks first —
 * terminating cannot be undone and does not wait for the run to agree —
 * then reports what happened.
 *
 * Press → confirming (Terminate / Keep) → busy → done (how many) or failed
 * (why, with the button offered again).
 */

export type TerminateState =
  | { phase: 'idle' }
  | { phase: 'confirming' }
  | { phase: 'busy' }
  | { phase: 'done'; count: number }
  | { phase: 'failed'; error: string };

export type TerminateAction =
  | { type: 'press' }
  | { type: 'keep' }
  | { type: 'confirm' }
  | { type: 'terminated'; count: number }
  | { type: 'refused'; error: string };

export const initialTerminateState: TerminateState = { phase: 'idle' };

export function terminateReducer(state: TerminateState, action: TerminateAction): TerminateState {
  switch (action.type) {
    case 'press':
      return state.phase === 'idle' || state.phase === 'failed' ? { phase: 'confirming' } : state;
    case 'keep':
      return state.phase === 'confirming' ? { phase: 'idle' } : state;
    case 'confirm':
      return state.phase === 'confirming' ? { phase: 'busy' } : state;
    case 'terminated':
      return state.phase === 'busy' ? { phase: 'done', count: action.count } : state;
    case 'refused':
      return state.phase === 'busy' ? { phase: 'failed', error: action.error } : state;
  }
}

/**
 * What the outcome line says. `single` is a button for one run (the run
 * page), otherwise it terminates all of an agent's stuck runs.
 */
export function terminateOutcome(state: TerminateState, single: boolean): string | null {
  if (state.phase === 'failed') return state.error;
  if (state.phase !== 'done') return null;
  if (single) return state.count > 0 ? 'Terminated.' : 'Nothing left to terminate.';
  if (state.count === 0) return 'No stuck runs left to terminate.';
  return `Terminated ${state.count} stuck run${state.count === 1 ? '' : 's'}.`;
}

/** The confirmation's question. */
export function terminateQuestion(single: boolean): string {
  return single
    ? 'Terminate this run? It stops where it is and cannot be resumed.'
    : 'Terminate every run stuck for over two hours? They stop where they are and cannot be resumed.';
}
