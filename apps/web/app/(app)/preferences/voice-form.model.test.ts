/**
 * The Voice section of Preferences (voice-form.model.ts), as a person
 * editing it would describe it. Choosing a language or voice is
 * chat/_components/voice-picker.model.test.ts's. The browser spec
 * (voice.spec.ts) keeps that the section renders with what was saved.
 */

import type { VoicePrefs } from '@renkei/user-prefs/prefs';
import {
  canSave,
  initVoicePrefsForm,
  isDirty,
  languageHint,
  speedLabel,
  voicePrefsFormReducer,
  type VoicePrefsFormAction,
  type VoicePrefsFormState,
} from './voice-form.model';

const SAVED: VoicePrefs = {
  voice: 'en-GB-SoniaNeural',
  rate: 1.25,
  autoPlay: false,
  locale: 'en-GB',
  detectLanguage: true,
  pushToTalk: false,
  accent: 'rainbow',
  userAccent: 'emerald',
};

const run = (
  actions: VoicePrefsFormAction[],
  from: VoicePrefsFormState = initVoicePrefsForm(SAVED)
) => actions.reduce(voicePrefsFormReducer, from);
const faster = { ...SAVED, rate: 1.5 };

describe('saving', () => {
  it('Save is off until something changes', () => {
    expect(canSave(run([]))).toBe(false);
    expect(canSave(run([{ type: 'changed', prefs: faster }]))).toBe(true);
  });

  it('changing it back turns Save off again', () => {
    expect(
      isDirty(
        run([
          { type: 'changed', prefs: faster },
          { type: 'changed', prefs: SAVED },
        ])
      )
    ).toBe(false);
  });

  it('Save is off while a save is on its way', () => {
    expect(canSave(run([{ type: 'changed', prefs: faster }, { type: 'saving' }]))).toBe(false);
  });

  it('a saved preference says "Saved." for a moment, then Save is off', () => {
    const saved = run([
      { type: 'changed', prefs: faster },
      { type: 'saving' },
      { type: 'saved', prefs: faster },
    ]);
    expect(saved.status).toBe('saved');
    expect(canSave(saved)).toBe(false);
    expect(run([{ type: 'saved-shown' }], saved).status).toBe('idle');
  });

  it('an edit made while saving stays unsaved', () => {
    const state = run([
      { type: 'changed', prefs: faster },
      { type: 'saving' },
      { type: 'changed', prefs: { ...faster, autoPlay: true } },
      { type: 'saved', prefs: faster },
    ]);
    expect(isDirty(state)).toBe(true);
  });

  it('a failed save says so and can be tried again', () => {
    const failed = run([
      { type: 'changed', prefs: faster },
      { type: 'saving' },
      { type: 'save-failed' },
    ]);
    expect(failed.status).toBe('failed');
    expect(canSave(failed)).toBe(true);
    expect(run([{ type: 'changed', prefs: SAVED }], failed).status).toBe('idle');
  });

  it('a late "Saved." timer does not clear a newer state', () => {
    const failed = run([{ type: 'saving' }, { type: 'save-failed' }]);
    expect(run([{ type: 'saved-shown' }], failed).status).toBe('failed');
  });
});

describe('the lines that follow the choices', () => {
  it('shows the speed to two places', () => {
    expect(speedLabel(1.25)).toBe('Speed: 1.25×');
    expect(speedLabel(1)).toBe('Speed: 1.00×');
  });

  it('says what the language is for, with and without detection', () => {
    expect(languageHint(true)).toMatch(/when your language cannot be told/);
    expect(languageHint(false)).toMatch(/voice mode listens for/);
  });
});
