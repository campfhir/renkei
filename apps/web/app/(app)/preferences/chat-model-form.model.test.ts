/**
 * The Chat model section of Preferences (chat-model-form.model.ts), as a
 * person using it would describe it.
 */

import {
  canSave,
  chatModelFormReducer,
  initChatModelForm,
  pickerHint,
  pickerOptions,
  pickerValue,
  requestBody,
  type ChatModelFormAction,
  type ChatModelOption,
} from './chat-model-form.model';

// As the page lists them: the organization's default first.
const HAIKU: ChatModelOption = { id: 'haiku', label: 'Claude Haiku', model: 'claude-haiku-5-5' };
const OPUS: ChatModelOption = { id: 'opus', label: 'Claude Opus', model: 'claude-opus-5-5' };
const MODELS = [HAIKU, OPUS];

const open = (modelId: string | null = null, models = MODELS) =>
  initChatModelForm({ initial: { modelId }, models });

const after = (state: ReturnType<typeof open>, ...actions: ChatModelFormAction[]) =>
  actions.reduce(chatModelFormReducer, state);

describe('the picker', () => {
  it('offers the organization default first, naming the model it is, then every chat model', () => {
    expect(pickerOptions(MODELS).map((option) => option.label)).toEqual([
      'Organization default (Claude Haiku)',
      'Claude Haiku · claude-haiku-5-5',
      'Claude Opus · claude-opus-5-5',
    ]);
  });

  it('opens on the saved model, or on the organization default with none saved', () => {
    expect(pickerValue(open('opus'))).toBe('opus');
    expect(pickerValue(open())).toBe('');
  });

  it('reads a saved model the organization no longer offers as no preference', () => {
    expect(pickerValue(open('removed'))).toBe('');
  });

  it('says projects come first, and what happens when the model is removed', () => {
    expect(pickerHint(MODELS)).toMatch(/unless their project names its own/);
    expect(pickerHint(MODELS)).toMatch(/told what replaced it/);
    expect(pickerHint([HAIKU])).toMatch(/one chat model/);
  });
});

describe('saving', () => {
  it('Save is off until the pick differs from what is stored', () => {
    const state = open('opus');
    expect(canSave(state)).toBe(false);
    expect(canSave(after(state, { type: 'picked', value: 'haiku' }))).toBe(true);
    expect(canSave(after(state, { type: 'picked', value: 'haiku' }, { type: 'picked', value: 'opus' }))).toBe(false);
  });

  it('sends the picked model as the chat model preference, and null for the default', () => {
    expect(requestBody(after(open(), { type: 'picked', value: 'opus' }))).toEqual({
      chatModel: { modelId: 'opus' },
    });
    expect(requestBody(after(open('opus'), { type: 'picked', value: '' }))).toEqual({
      chatModel: { modelId: null },
    });
  });

  it('a save that lands turns Save off; one that fails keeps the pick to try again', () => {
    const picked = after(open(), { type: 'picked', value: 'opus' }, { type: 'saving' });
    expect(canSave(picked)).toBe(false);
    const saved = after(picked, { type: 'saved', modelId: 'opus' });
    expect(saved.status).toBe('saved');
    expect(canSave(saved)).toBe(false);
    const failed = after(picked, { type: 'save-failed' });
    expect(failed.status).toBe('failed');
    expect(canSave(failed)).toBe(true);
  });
});
