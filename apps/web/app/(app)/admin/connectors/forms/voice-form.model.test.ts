/**
 * The admin Voice connector form (voice-form.model.ts), as an admin
 * setting it up would describe it. The browser spec (voice.spec.ts)
 * keeps that the form renders the stored configuration on the real
 * server and that Test connection reaches the route and draws its answer.
 */

import {
  canTest,
  initialVoiceForm,
  saveBody,
  testOutcome,
  voiceFormReducer,
  type VoiceConfigView,
  type VoiceFormAction,
} from './voice-form.model';

const STORED: VoiceConfigView = {
  configured: true,
  enabled: false,
  provider: 'azure-speech',
  providers: ['azure-speech'],
  region: 'eastus',
  endpoint: null,
  defaultVoice: 'en-US-AvaMultilingualNeural',
  defaultLocale: 'en-US',
  hasApiKey: true,
};

const run = (actions: VoiceFormAction[], from = initialVoiceForm) =>
  actions.reduce(voiceFormReducer, from);
const loaded = run([{ type: 'loaded', config: STORED }]);

describe('filling the form', () => {
  it('shows what is stored, the key never', () => {
    expect(loaded.fields).toEqual({
      provider: 'azure-speech',
      region: 'eastus',
      endpoint: '',
      apiKey: '',
      defaultVoice: 'en-US-AvaMultilingualNeural',
      defaultLocale: 'en-US',
      enabled: false,
    });
  });

  it('a service never saved starts enabled', () => {
    const fresh = run([
      { type: 'loaded', config: { ...STORED, configured: false, enabled: false } },
    ]);
    expect(fresh.fields.enabled).toBe(true);
  });
});

describe('saving', () => {
  it('sends trimmed values and a typed key', () => {
    const edited = run(
      [{ type: 'edit', patch: { region: ' westeurope ', apiKey: ' secret ', enabled: true } }],
      loaded
    );
    expect(saveBody(edited.fields)).toEqual({
      provider: 'azure-speech',
      region: 'westeurope',
      endpoint: '',
      apiKey: 'secret',
      defaultVoice: 'en-US-AvaMultilingualNeural',
      defaultLocale: 'en-US',
      enabled: true,
    });
  });

  it('a blank key keeps the stored one: it is left out', () => {
    expect(
      saveBody(run([{ type: 'edit', patch: { apiKey: '   ' } }], loaded).fields)
    ).not.toHaveProperty('apiKey');
  });

  it('a save says Saved and clears the typed key', () => {
    const saved = run(
      [{ type: 'edit', patch: { apiKey: 'secret' } }, { type: 'saving' }, { type: 'saved' }],
      loaded
    );
    expect(saved).toMatchObject({ busy: false, notice: 'Saved', error: null });
    expect(saved.fields.apiKey).toBe('');
  });

  it('a refused save says why and keeps what was typed', () => {
    const refused = run(
      [
        { type: 'edit', patch: { apiKey: 'secret' } },
        { type: 'saving' },
        { type: 'save-failed', error: 'Region or endpoint required' },
      ],
      loaded
    );
    expect(refused).toMatchObject({ busy: false, error: 'Region or endpoint required' });
    expect(refused.fields.apiKey).toBe('secret');
  });
});

describe('testing the connection', () => {
  it('is offered once saved, and not during a save or another test', () => {
    expect(canTest(loaded, STORED)).toBe(true);
    expect(canTest(loaded, { ...STORED, configured: false })).toBe(false);
    expect(canTest(loaded, null)).toBe(false);
    expect(canTest(run([{ type: 'saving' }], loaded), STORED)).toBe(false);
    expect(canTest(run([{ type: 'testing' }], loaded), STORED)).toBe(false);
  });

  it('says how many voices in how many languages it found', () => {
    expect(testOutcome(200, true, { voices: 612, locales: 153, defaultVoiceKnown: true })).toEqual({
      type: 'tested',
      notice: 'Connected: 612 voices in 153 languages.',
    });
  });

  it('warns when the default voice is not one of them', () => {
    expect(
      testOutcome(200, true, { voices: 3, locales: 1, defaultVoiceKnown: false })
    ).toMatchObject({
      notice:
        'Connected: 3 voices in 1 languages. The default voice is not one of them — check its name.',
    });
  });

  it('a failed test says the service’s reason, or the status', () => {
    expect(testOutcome(502, false, { error: 'Key rejected' })).toEqual({
      type: 'test-failed',
      error: 'Key rejected',
    });
    expect(testOutcome(500, false, null)).toEqual({
      type: 'test-failed',
      error: 'Test failed (500)',
    });
  });

  it('a new test clears the last answer, and its own answer replaces it', () => {
    const answered = run([{ type: 'testing' }, testOutcome(500, false, null)], loaded);
    expect(answered).toMatchObject({ testing: false, error: 'Test failed (500)' });
    const again = run([{ type: 'testing' }], answered);
    expect(again).toMatchObject({ testing: true, error: null, notice: null });
  });
});
