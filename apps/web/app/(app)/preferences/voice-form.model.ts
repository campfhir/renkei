/**
 * The Voice section of Preferences (voice-form.tsx), with no network,
 * timer or React: the preference being edited against the one last
 * saved, whether Save is on, what a save leaves on screen, and the
 * lines that change with the choices. Choosing a language or a voice is
 * the pickers' rule (chat/_components/voice-picker.model.ts), the same
 * as in the chat's speaker menu. Tested in voice-form.model.test.ts.
 */

import type { VoicePrefs } from '@renkei/user-prefs/prefs';

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'failed';

export interface VoicePrefsFormState {
  prefs: VoicePrefs;
  /** What the server last stored. */
  saved: VoicePrefs;
  status: SaveStatus;
}

export function initVoicePrefsForm(initial: VoicePrefs): VoicePrefsFormState {
  return { prefs: initial, saved: initial, status: 'idle' };
}

export type VoicePrefsFormAction =
  | { type: 'changed'; prefs: VoicePrefs }
  | { type: 'saving' }
  /** The server stored `prefs` (what Save sent, not any edit made since). */
  | { type: 'saved'; prefs: VoicePrefs }
  | { type: 'save-failed' }
  /** "Saved." has been up long enough (the component's two seconds). */
  | { type: 'saved-shown' };

export function voicePrefsFormReducer(
  state: VoicePrefsFormState,
  action: VoicePrefsFormAction
): VoicePrefsFormState {
  switch (action.type) {
    case 'changed':
      return { ...state, prefs: action.prefs, status: 'idle' };
    case 'saving':
      return { ...state, status: 'saving' };
    case 'saved':
      return { ...state, saved: action.prefs, status: 'saved' };
    case 'save-failed':
      return { ...state, status: 'failed' };
    case 'saved-shown':
      return state.status === 'saved' ? { ...state, status: 'idle' } : state;
  }
}

/** Something differs from what is stored. */
export function isDirty(state: VoicePrefsFormState): boolean {
  return JSON.stringify(state.prefs) !== JSON.stringify(state.saved);
}

/** Save is on once something changed, and not while a save is on its way. */
export function canSave(state: VoicePrefsFormState): boolean {
  return state.status !== 'saving' && isDirty(state);
}

/** The speed slider's label: "Speed: 1.25×". */
export function speedLabel(rate: number): string {
  return `Speed: ${rate.toFixed(2)}×`;
}

/** What the language is for, which depends on whether the spoken language is detected. */
export function languageHint(detectLanguage: boolean): string {
  return detectLanguage
    ? 'The language replies are spoken in, which voices lead the list, and what is listened for when your language cannot be told.'
    : 'The language replies are spoken in and voice mode listens for, and which voices lead the list.';
}
