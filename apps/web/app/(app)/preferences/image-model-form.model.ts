/**
 * The Image generation section of Preferences (image-model-form.tsx),
 * with no network or React: the model picked against the one last saved,
 * whether Save is on, what Save sends, what a save leaves on screen, and
 * what the picker offers. "Organization default" is no preference (null):
 * the chat takes the org's first image model by name, which is how the
 * page lists them. Tested in image-model-form.model.test.ts.
 */

export interface ImageModelOption {
  id: string;
  label: string;
  model: string;
}

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'failed';

export interface ImageModelFormState {
  models: readonly ImageModelOption[];
  modelId: string | null;
  /** What the server last stored, as the picker reads it. */
  saved: string | null;
  status: SaveStatus;
}

/** A saved id the org no longer offers reads as no preference, as the chat treats it. */
function known(models: readonly ImageModelOption[], id: string | null): string | null {
  return id && models.some((model) => model.id === id) ? id : null;
}

export function initImageModelForm(input: {
  initial: { modelId: string | null };
  models: readonly ImageModelOption[];
}): ImageModelFormState {
  const id = known(input.models, input.initial.modelId);
  return { models: input.models, modelId: id, saved: id, status: 'idle' };
}

export type ImageModelFormAction =
  /** The picker's value: '' is the organization default. */
  | { type: 'picked'; value: string }
  | { type: 'saving' }
  /** The server stored `modelId` (what Save sent). */
  | { type: 'saved'; modelId: string | null }
  | { type: 'save-failed' };

export function imageModelFormReducer(
  state: ImageModelFormState,
  action: ImageModelFormAction
): ImageModelFormState {
  switch (action.type) {
    case 'picked':
      return { ...state, modelId: action.value || null, status: 'idle' };
    case 'saving':
      return { ...state, status: 'saving' };
    case 'saved':
      return { ...state, saved: action.modelId, status: 'saved' };
    case 'save-failed':
      return { ...state, status: 'failed' };
  }
}

/** Save is on once the pick differs from what is stored, and not while a save is on its way. */
export function canSave(state: ImageModelFormState): boolean {
  return state.status !== 'saving' && state.modelId !== state.saved;
}

/** What Save PUTs to /api/preferences. */
export function requestBody(state: ImageModelFormState): { image: { modelId: string | null } } {
  return { image: { modelId: state.modelId } };
}

/** The picker's value: '' for the organization default. */
export function pickerValue(state: ImageModelFormState): string {
  return state.modelId ?? '';
}

/** The picker's options, the organization default first, naming the model it is. */
export function pickerOptions(
  models: readonly ImageModelOption[]
): { value: string; label: string }[] {
  const first = models[0];
  return [
    { value: '', label: `Organization default${first ? ` (${first.label})` : ''}` },
    ...models.map((model) => ({ value: model.id, label: `${model.label} · ${model.model}` })),
  ];
}

/** The line under the picker. */
export function pickerHint(models: readonly ImageModelOption[]): string {
  return models.length > 1
    ? 'Your chats use this model for every picture. If an administrator turns it off, they fall back to the organization default.'
    : 'Your organization has one image model, so every picture comes from it.';
}

export function saveLabel(state: ImageModelFormState): string {
  return state.status === 'saving' ? 'Saving…' : 'Save';
}
