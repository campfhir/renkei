/**
 * When the composer's unsent text is saved (use-draft-sync.ts): typing
 * waits for the box to be still, clearing saves at once, one save is in
 * flight at a time, a change made during it is saved after it with the
 * newest text, and a failed save leaves the saved copy behind so the next
 * change tries again. The hook holds the timer and the request; tested in
 * draft-sync.model.test.ts.
 */

export const SAVE_DELAY_MS = 800;

/** When a change to the box is saved: not at all, at once, or after the pause. */
export function saveTiming(
  text: string,
  saved: string,
  enabled: boolean
): 'none' | 'now' | 'afterPause' {
  if (!enabled || text === saved) return 'none';
  // A send or a cancel clears the box: a sent message must never come back as a draft.
  return text.length === 0 ? 'now' : 'afterPause';
}

export interface DraftSync {
  /** What the server holds, as far as this page knows. */
  saved: string;
  /** The text of the save in flight, or null. */
  inflight: string | null;
  /** A save was asked for while one was in flight: go again once it answers. */
  again: boolean;
}

export const initialDraftSync = (saved: string): DraftSync => ({
  saved,
  inflight: null,
  again: false,
});

/** The next state, and the text to send now (null: send nothing). */
export interface DraftStep {
  state: DraftSync;
  save: string | null;
}

function start(state: DraftSync, latest: string): DraftStep {
  if (latest === state.saved)
    return { state: { ...state, inflight: null, again: false }, save: null };
  return { state: { ...state, inflight: latest, again: false }, save: latest };
}

/** A save is asked for, with the box's text as it is now. */
export function saveRequested(state: DraftSync, latest: string): DraftStep {
  if (state.inflight !== null) return { state: { ...state, again: true }, save: null };
  return start(state, latest);
}

/** The save in flight answered; `latest` is the box's text now. */
export function saveAnswered(state: DraftSync, ok: boolean, latest: string): DraftStep {
  if (state.inflight === null) return { state, save: null };
  if (!ok) return { state: { ...state, inflight: null, again: false }, save: null };
  const saved = state.inflight;
  const settled = { saved, inflight: null, again: false };
  return state.again ? start(settled, latest) : { state: settled, save: null };
}
