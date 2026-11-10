/**
 * A sub-agent's run modal, with no React: what it shows while the run is
 * read, while its call has not started yet, and once the run is there;
 * when it keeps asking again; and Stop — offered to the chat's owner
 * while the sub-agent is still working, what pressing it leaves on screen,
 * and what a refusal says. subagent-modal.tsx renders from this and makes
 * the calls. Tested in subagent-modal.model.test.ts.
 */

import type { SubagentRunView } from '@/lib/chat/subagent-runs';

const NOT_RECORDED = 'No such sub-agent run';

export interface SubagentModalState {
  run: SubagentRunView | null;
  /** The delegating call has not started its run yet: wait, and ask again. */
  queued: boolean;
  /** The run could not be read, in words. */
  error: string | null;
  /**
   * Stop: not pressed, on its way, or asked — the sub-agent stops at its
   * next step, so the run still reads "working" for a moment after.
   */
  stop: 'idle' | 'stopping' | 'asked';
  /** A Stop the server refused, in its words; the run is still shown. */
  stopError: string | null;
}

export type SubagentModalAction =
  | { type: 'loaded'; run: SubagentRunView }
  /** The read failed; `notStarted` says the delegating call is still waiting its turn. */
  | { type: 'loadFailed'; message: string | null; notStarted: boolean }
  | { type: 'stopPressed' }
  | { type: 'stopAsked' }
  | { type: 'stopRefused'; message: string };

export const initialSubagentModal: SubagentModalState = {
  run: null,
  queued: false,
  error: null,
  stop: 'idle',
  stopError: null,
};

export function subagentModalReducer(
  state: SubagentModalState,
  action: SubagentModalAction
): SubagentModalState {
  switch (action.type) {
    case 'loaded':
      return {
        ...state,
        run: action.run,
        queued: false,
        error: null,
        // A run that has ended has nothing left to stop.
        ...(action.run.status === 'running' ? {} : { stop: 'idle' as const, stopError: null }),
      };
    case 'loadFailed':
      if (action.message === NOT_RECORDED && action.notStarted) {
        return { ...state, queued: true, error: null };
      }
      return {
        ...state,
        queued: false,
        error:
          action.message === NOT_RECORDED
            ? 'This sub-agent’s run was not recorded — it ran before runs were kept, or its turn was removed.'
            : (action.message ?? 'The sub-agent’s run could not be read.'),
      };
    case 'stopPressed':
      return canStop(state, true) ? { ...state, stop: 'stopping', stopError: null } : state;
    case 'stopAsked':
      return { ...state, stop: 'asked', stopError: null };
    case 'stopRefused':
      return { ...state, stop: 'idle', stopError: action.message };
  }
}

/** Whether the modal asks again in a few seconds: a run still going, or one not started. */
export function keepsAsking(state: SubagentModalState): boolean {
  return state.error === null && (state.queued || state.run?.status === 'running');
}

/** Whether Stop is on the page at all: the owner's, while the sub-agent works. */
export function showsStop(state: SubagentModalState, isOwner: boolean): boolean {
  return isOwner && state.error === null && state.run?.status === 'running';
}

/** Whether Stop can be pressed now: shown, and not already pressed. */
export function canStop(state: SubagentModalState, isOwner: boolean): boolean {
  return showsStop(state, isOwner) && state.stop === 'idle';
}

/** What the Stop button says. */
export function stopLabel(state: SubagentModalState): string {
  return state.stop === 'idle' ? 'Stop sub-agent' : 'Stopping…';
}

export function statusWord(run: Pick<SubagentRunView, 'status'>): string {
  switch (run.status) {
    case 'running':
      return 'working';
    case 'completed':
      return 'done';
    case 'failed':
      return 'failed';
    case 'interrupted':
      return 'stopped';
  }
}
