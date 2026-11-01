import {
  canSave,
  imageModelFormReducer,
  initImageModelForm,
  pickerHint,
  pickerOptions,
  pickerValue,
  requestBody,
  saveLabel,
  type ImageModelFormAction,
  type ImageModelOption,
} from './image-model-form.model';

// As the page lists them: the org's image models by name.
const FOX: ImageModelOption = { id: 'fox', label: 'Fox', model: 'FLUX.2-flex' };
const PAINTER: ImageModelOption = { id: 'painter', label: 'Painter', model: 'gpt-image-1' };
const MODELS = [FOX, PAINTER];

const open = (modelId: string | null = null, models = MODELS) =>
  initImageModelForm({ initial: { modelId }, models });

const after = (state: ReturnType<typeof open>, ...actions: ImageModelFormAction[]) =>
  actions.reduce(imageModelFormReducer, state);

describe('the picker', () => {
  it('offers the organization default first, naming the model it is, then every model with its engine', () => {
    expect(pickerOptions(MODELS).map((option) => option.label)).toEqual([
      'Organization default (Fox)',
      'Fox · FLUX.2-flex',
      'Painter · gpt-image-1',
    ]);
    expect(pickerOptions(MODELS)[0].value).toBe('');
  });

  it('opens on the organization default with no preference stored', () => {
    expect(pickerValue(open())).toBe('');
  });

  it('opens on the stored pick', () => {
    expect(pickerValue(open('painter'))).toBe('painter');
  });

  it('a stored pick the org no longer offers reads as the organization default', () => {
    const state = open('gone');
    expect(pickerValue(state)).toBe('');
    expect(canSave(state)).toBe(false);
  });

  it('says so when there is only one model to come from', () => {
    expect(pickerHint([FOX])).toBe(
      'Your organization has one image model, so every picture comes from it.'
    );
    expect(pickerHint(MODELS)).toMatch(/fall back to the organization default/);
  });
});

describe('Save', () => {
  it('is off until the pick differs from what is stored', () => {
    const state = open();
    expect(canSave(state)).toBe(false);
    expect(canSave(after(state, { type: 'picked', value: 'painter' }))).toBe(true);
    expect(
      canSave(after(state, { type: 'picked', value: 'painter' }, { type: 'picked', value: '' }))
    ).toBe(false);
  });

  it("sends the model's id", () => {
    expect(requestBody(after(open(), { type: 'picked', value: 'painter' }))).toEqual({
      image: { modelId: 'painter' },
    });
  });

  it('back to the organization default clears the preference', () => {
    expect(requestBody(after(open('painter'), { type: 'picked', value: '' }))).toEqual({
      image: { modelId: null },
    });
  });

  it('is off and says Saving… while the save is on its way, then Saved. and off again', () => {
    const saving = after(open(), { type: 'picked', value: 'painter' }, { type: 'saving' });
    expect(canSave(saving)).toBe(false);
    expect(saveLabel(saving)).toBe('Saving…');
    const saved = after(saving, { type: 'saved', modelId: 'painter' });
    expect(saved.status).toBe('saved');
    expect(saveLabel(saved)).toBe('Save');
    expect(canSave(saved)).toBe(false);
  });

  it('a failed save says so and leaves the pick to try again', () => {
    const failed = after(
      open(),
      { type: 'picked', value: 'painter' },
      { type: 'saving' },
      { type: 'save-failed' }
    );
    expect(failed.status).toBe('failed');
    expect(pickerValue(failed)).toBe('painter');
    expect(canSave(failed)).toBe(true);
  });

  it('a new pick clears the last outcome', () => {
    const saved = after(
      open(),
      { type: 'picked', value: 'painter' },
      { type: 'saving' },
      { type: 'saved', modelId: 'painter' },
      { type: 'picked', value: 'fox' }
    );
    expect(saved.status).toBe('idle');
    expect(canSave(saved)).toBe(true);
  });
});
