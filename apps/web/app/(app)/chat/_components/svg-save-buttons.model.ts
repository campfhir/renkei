/**
 * "Save as image" under an SVG the model wrote (svg-save-buttons.tsx),
 * with no DOM, timer or download: a press while a save is running does
 * nothing, a save confirms on its own button for a moment, and a failure
 * leaves its reason on screen until the next save. What counts as an SVG
 * and how it is drawn is lib/svg-image.ts. Tested in
 * svg-save-buttons.model.test.ts.
 */

export type SvgSaveFormat = 'png' | 'svg';

export const SVG_SAVE_FORMATS: readonly SvgSaveFormat[] = ['png', 'svg'];

/** How long "Saved" stays on the button, ms (the component's timer). */
export const SAVED_SHOWN_MS = 2000;

export type SvgSaveStatus =
  { kind: 'idle' } | { kind: 'saved'; format: SvgSaveFormat } | { kind: 'error'; message: string };

export interface SvgSaveState {
  status: SvgSaveStatus;
  busy: boolean;
}

export const initSvgSave = (): SvgSaveState => ({ status: { kind: 'idle' }, busy: false });

export type SvgSaveAction =
  | { type: 'started' }
  | { type: 'saved'; format: SvgSaveFormat }
  /** The save failed: `message` is what it said, when it said something fit to show. */
  | { type: 'failed'; message: string | null }
  /** "Saved" has been up long enough. */
  | { type: 'saved-shown' };

export function svgSaveReducer(state: SvgSaveState, action: SvgSaveAction): SvgSaveState {
  switch (action.type) {
    case 'started':
      return { ...state, busy: true };
    case 'saved':
      return { busy: false, status: { kind: 'saved', format: action.format } };
    case 'failed':
      return {
        busy: false,
        status: { kind: 'error', message: action.message || 'The image could not be saved.' },
      };
    case 'saved-shown':
      return state.status.kind === 'saved' ? { ...state, status: { kind: 'idle' } } : state;
  }
}

/** A press starts a save only while none is running. */
export function canStart(state: SvgSaveState): boolean {
  return !state.busy;
}

/** One button's face: "PNG" with a download glyph, or "Saved" with a tick for a moment after. */
export function buttonFor(state: SvgSaveState, format: SvgSaveFormat) {
  const saved = state.status.kind === 'saved' && state.status.format === format;
  const name = format.toUpperCase();
  return {
    label: `Save as ${name}`,
    text: saved ? 'Saved' : name,
    icon: saved ? ('check' as const) : ('download' as const),
    disabled: state.busy,
  };
}

/** What the polite live region announces. */
export function announcement(state: SvgSaveState): string {
  return state.status.kind === 'saved' ? `Saved as ${state.status.format.toUpperCase()}` : '';
}

/** The reason a save failed, shown beside the buttons, or null. */
export function errorText(state: SvgSaveState): string | null {
  return state.status.kind === 'error' ? state.status.message : null;
}
