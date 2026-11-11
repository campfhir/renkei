/**
 * A project's own model (project-model.model.ts), as a person setting it
 * would describe it.
 */

import {
  initProjectModel,
  NO_MODEL_LABEL,
  pickerOptions,
  pickerValue,
  projectModelReducer,
  requestBody,
  showsPicker,
  type ProjectModelAction,
} from './project-model.model';

const MODELS = [
  { id: 'haiku', label: 'Claude Haiku', model: 'claude-haiku-5-5' },
  { id: 'opus', label: 'Claude Opus', model: 'claude-opus-5-5' },
];

const open = (llmModelId: string | null, ...actions: ProjectModelAction[]) =>
  actions.reduce(projectModelReducer, initProjectModel({ llmModelId }));

const loaded = (llmModelId: string | null, ...actions: ProjectModelAction[]) =>
  open(llmModelId, { type: 'modelsLoaded', models: MODELS }, ...actions);

describe('the picker', () => {
  it('stays hidden until the models load, and when the organization has none', () => {
    expect(showsPicker(open(null))).toBe(false);
    expect(showsPicker(open(null, { type: 'modelsLoaded', models: [] }))).toBe(false);
    expect(showsPicker(loaded(null))).toBe(true);
  });

  it('offers "no model of its own" first, then every chat model', () => {
    expect(pickerOptions(loaded(null)).map((option) => option.label)).toEqual([
      NO_MODEL_LABEL,
      'Claude Haiku · claude-haiku-5-5',
      'Claude Opus · claude-opus-5-5',
    ]);
  });

  it("opens on the project's model, or on none of its own", () => {
    expect(pickerValue(loaded('opus'))).toBe('opus');
    expect(pickerValue(loaded(null))).toBe('');
  });

  it('reads a model the organization no longer offers as none of its own', () => {
    expect(pickerValue(loaded('removed'))).toBe('');
  });
});

describe('picking', () => {
  it('sends the model picked, and null for none of its own', () => {
    expect(requestBody('opus')).toEqual({ llmModelId: 'opus' });
    expect(requestBody('')).toEqual({ llmModelId: null });
  });

  it('shows the pick at once and keeps it when the save lands', () => {
    const picked = loaded(null, { type: 'picked', value: 'opus' });
    expect(pickerValue(picked)).toBe('opus');
    expect(picked.saving).toBe(true);
    const saved = projectModelReducer(picked, { type: 'saved' });
    expect(pickerValue(saved)).toBe('opus');
    expect(saved.saving).toBe(false);
  });

  it('a refused save puts the picker back and says why', () => {
    const failed = loaded(
      'haiku',
      { type: 'picked', value: 'opus' },
      { type: 'saveFailed', error: 'Only editors can change this project.' }
    );
    expect(pickerValue(failed)).toBe('haiku');
    expect(failed.error).toBe('Only editors can change this project.');
  });

  it('the next pick clears the last refusal', () => {
    const again = loaded(
      'haiku',
      { type: 'picked', value: 'opus' },
      { type: 'saveFailed', error: undefined },
      { type: 'picked', value: 'opus' }
    );
    expect(again.error).toBeNull();
  });
});
