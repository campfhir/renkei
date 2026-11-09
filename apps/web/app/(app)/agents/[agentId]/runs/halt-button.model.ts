/**
 * The Halt button: stuck runs (queued or running for over two hours)
 * closed out directly, because a cancel never reaches them. It asks first —
 * halting cannot be undone and does not wait for the run to agree —
 * then reports what happened.
 *
 * Press → confirming (Halt / Keep) → busy → done (how many) or failed
 * (why, with the button offered again).
 */

export type HaltState =
  | { phase: 'idle' }
  | { phase: 'confirming' }
  | { phase: 'busy' }
  | { phase: 'done'; count: number }
  | { phase: 'failed'; error: string };

export type HaltAction =
  | { type: 'press' }
  | { type: 'keep' }
  | { type: 'confirm' }
  | { type: 'halted'; count: number }
  | { type: 'refused'; error: string };

export const initialHaltState: HaltState = { phase: 'idle' };

export function haltReducer(state: HaltState, action: HaltAction): HaltState {
  switch (action.type) {
    case 'press':
      return state.phase === 'idle' || state.phase === 'failed' ? { phase: 'confirming' } : state;
    case 'keep':
      return state.phase === 'confirming' ? { phase: 'idle' } : state;
    case 'confirm':
      return state.phase === 'confirming' ? { phase: 'busy' } : state;
    case 'halted':
      return state.phase === 'busy' ? { phase: 'done', count: action.count } : state;
    case 'refused':
      return state.phase === 'busy' ? { phase: 'failed', error: action.error } : state;
  }
}

/**
 * What the outcome line says. `single` is a button for one run (the run
 * page), otherwise it halts all of an agent's stuck runs.
 */
export function haltOutcome(state: HaltState, single: boolean): string | null {
  if (state.phase === 'failed') return state.error;
  if (state.phase !== 'done') return null;
  if (single) return state.count > 0 ? 'Halted.' : 'Nothing left to halt.';
  if (state.count === 0) return 'No stuck runs left to halt.';
  return `Halted ${state.count} stuck run${state.count === 1 ? '' : 's'}.`;
}

/** The confirmation's question. */
export function haltQuestion(single: boolean): string {
  return single
    ? 'Halt this run? It stops where it is and cannot be resumed.'
    : 'Halt every run stuck for over two hours? They stop where they are and cannot be resumed.';
}
