/**
 * The Code project model section of Preferences (code-model-form.model.ts),
 * as a person using it would describe it.
 */

import {
  canSave,
  codeModelFormReducer,
  initCodeModelForm,
  pickerHint,
  pickerOptions,
  pickerValue,
  requestBody,
  type CodeModelFormAction,
  type CodeModelOption,
} from './code-model-form.model';

// As the page lists them: the organization's default first.
const HAIKU: CodeModelOption = { id: 'haiku', label: 'Claude Haiku', model: 'claude-haiku-5-5' };
const OPUS: CodeModelOption = { id: 'opus', label: 'Claude Opus', model: 'claude-opus-5-5' };
const MODELS = [HAIKU, OPUS];

const open = (modelId: string | null = null, models = MODELS) =>
  initCodeModelForm({ initial: { modelId }, models });

const after = (state: ReturnType<typeof open>, ...actions: CodeModelFormAction[]) =>
  actions.reduce(codeModelFormReducer, state);

describe('the picker', () => {
  it('offers "same as my chat model" first, naming the preferred chat model, then every chat model', () => {
    expect(pickerOptions(MODELS, 'opus').map((option) => option.label)).toEqual([
      'Same as my chat model (Claude Opus)',
      'Claude Haiku · claude-haiku-5-5',
      'Claude Opus · claude-opus-5-5',
    ]);
  });

  it('names the organization default with no chat model preferred, or one no longer offered', () => {
    expect(pickerOptions(MODELS, null)[0]?.label).toBe('Same as my chat model (Claude Haiku)');
    expect(pickerOptions(MODELS, 'removed')[0]?.label).toBe('Same as my chat model (Claude Haiku)');
  });

  it('opens on the saved model, or on "same as my chat model" with none saved', () => {
    expect(pickerValue(open('opus'))).toBe('opus');
    expect(pickerValue(open())).toBe('');
  });

  it('reads a saved model the organization no longer offers as no preference', () => {
    expect(pickerValue(open('removed'))).toBe('');
  });

  it('says projects come first, what none picked means, and what happens when the model is removed', () => {
    expect(pickerHint(MODELS)).toMatch(/unless the project names its own/);
    expect(pickerHint(MODELS)).toMatch(/your chat model, else the organization default/);
    expect(pickerHint(MODELS)).toMatch(/told what replaced it/);
    expect(pickerHint([HAIKU])).toMatch(/one chat model/);
  });
});

describe('saving', () => {
  it('Save is off until the pick differs from what is stored', () => {
    const state = open('opus');
    expect(canSave(state)).toBe(false);
    expect(canSave(after(state, { type: 'picked', value: 'haiku' }))).toBe(true);
    expect(
      canSave(after(state, { type: 'picked', value: 'haiku' }, { type: 'picked', value: 'opus' }))
    ).toBe(false);
  });

  it('sends the picked model as the code project model preference, and null for none', () => {
    expect(requestBody(after(open(), { type: 'picked', value: 'opus' }))).toEqual({
      codeModel: { modelId: 'opus' },
    });
    expect(requestBody(after(open('opus'), { type: 'picked', value: '' }))).toEqual({
      codeModel: { modelId: null },
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
