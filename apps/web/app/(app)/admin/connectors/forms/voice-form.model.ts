/**
 * The admin Voice connector form (voice-form.tsx), with no network or
 * React: the fields as the stored configuration fills them, what Save
 * sends (a blank key keeps the stored one), what a save or a connection
 * test leaves on screen, and when Test can be pressed. Tested in
 * voice-form.model.test.ts.
 */

import { recordOrNull } from '@renkei/guards';

export interface VoiceConfigView {
  configured: boolean;
  enabled: boolean;
  provider: string;
  providers: string[];
  region: string | null;
  endpoint: string | null;
  defaultVoice: string;
  defaultLocale: string;
  hasApiKey: boolean;
}

export const PROVIDER_LABELS: Record<string, string> = {
  'azure-speech': 'Azure AI Speech',
};

export interface VoiceFormFields {
  provider: string;
  region: string;
  endpoint: string;
  apiKey: string;
  defaultVoice: string;
  defaultLocale: string;
  enabled: boolean;
}

export interface VoiceFormState {
  fields: VoiceFormFields;
  busy: boolean;
  testing: boolean;
  notice: string | null;
  error: string | null;
}

export const initialVoiceForm: VoiceFormState = {
  fields: {
    provider: 'azure-speech',
    region: '',
    endpoint: '',
    apiKey: '',
    defaultVoice: '',
    defaultLocale: '',
    enabled: true,
  },
  busy: false,
  testing: false,
  notice: null,
  error: null,
};

export type VoiceFormAction =
  /** The stored configuration arrived (or arrived again after a save). */
  | { type: 'loaded'; config: VoiceConfigView }
  | { type: 'edit'; patch: Partial<VoiceFormFields> }
  | { type: 'saving' }
  | { type: 'saved' }
  | { type: 'save-failed'; error: string }
  | { type: 'testing' }
  | { type: 'tested'; notice: string }
  | { type: 'test-failed'; error: string };

export function voiceFormReducer(state: VoiceFormState, action: VoiceFormAction): VoiceFormState {
  switch (action.type) {
    case 'loaded': {
      const { config } = action;
      return {
        ...state,
        fields: {
          ...state.fields,
          provider: config.provider,
          region: config.region ?? '',
          endpoint: config.endpoint ?? '',
          defaultVoice: config.defaultVoice,
          defaultLocale: config.defaultLocale,
          // A service never saved starts enabled: saving it is turning it on.
          enabled: config.configured ? config.enabled : true,
        },
      };
    }
    case 'edit':
      return { ...state, fields: { ...state.fields, ...action.patch } };
    case 'saving':
      return { ...state, busy: true, notice: null, error: null };
    case 'saved':
      return { ...state, busy: false, notice: 'Saved', fields: { ...state.fields, apiKey: '' } };
    case 'save-failed':
      return { ...state, busy: false, error: action.error };
    case 'testing':
      return { ...state, testing: true, notice: null, error: null };
    case 'tested':
      return { ...state, testing: false, notice: action.notice };
    case 'test-failed':
      return { ...state, testing: false, error: action.error };
  }
}

/** What Save sends: trimmed values, and the key only when one was typed. */
export function saveBody(fields: VoiceFormFields): Record<string, unknown> {
  const apiKey = fields.apiKey.trim();
  return {
    provider: fields.provider,
    region: fields.region.trim(),
    endpoint: fields.endpoint.trim(),
    // Blank means keep the stored key — omit it from the payload.
    ...(apiKey ? { apiKey } : {}),
    defaultVoice: fields.defaultVoice.trim(),
    defaultLocale: fields.defaultLocale.trim(),
    enabled: fields.enabled,
  };
}

/** Test is offered once the service is saved, and not while a save or a test is under way. */
export function canTest(state: VoiceFormState, config: VoiceConfigView | null): boolean {
  return Boolean(config?.configured) && !state.testing && !state.busy;
}

/** What the connection test's answer says on the form. */
export function testOutcome(
  status: number,
  ok: boolean,
  body: unknown
): { type: 'tested'; notice: string } | { type: 'test-failed'; error: string } {
  const record = recordOrNull(body) ?? {};
  if (!ok) {
    return {
      type: 'test-failed',
      error: typeof record.error === 'string' ? record.error : `Test failed (${status})`,
    };
  }
  const voices = typeof record.voices === 'number' ? record.voices : 0;
  const locales = typeof record.locales === 'number' ? record.locales : 0;
  return {
    type: 'tested',
    notice:
      `Connected: ${voices} voices in ${locales} languages.` +
      (record.defaultVoiceKnown === false
        ? ' The default voice is not one of them — check its name.'
        : ''),
  };
}
