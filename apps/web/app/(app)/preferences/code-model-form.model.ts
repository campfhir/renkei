/**
 * The Code project model section of Preferences (code-model-form.tsx),
 * with no network or React. The same form as the chat model's — a pick
 * against the one last saved, Save on or off, what a save leaves on screen
 * (image-model-form.model.ts) — over the org's chat models, with its own
 * request and wording. No preference (null) is "the same as my chat
 * model": a new chat in a code project then starts on the person's
 * preferred chat model, else the org's default, which the page lists
 * first. Tested in code-model-form.model.test.ts.
 */

import {
  imageModelFormReducer,
  initImageModelForm,
  type ImageModelFormAction,
  type ImageModelFormState,
  type ImageModelOption,
} from './image-model-form.model';

export { canSave, pickerValue, saveLabel } from './image-model-form.model';

export type CodeModelOption = ImageModelOption;
export type CodeModelFormState = ImageModelFormState;
export type CodeModelFormAction = ImageModelFormAction;

export const initCodeModelForm = initImageModelForm;
export const codeModelFormReducer = imageModelFormReducer;

/** What Save PATCHes to /api/preferences. */
export function requestBody(state: CodeModelFormState): { codeModel: { modelId: string | null } } {
  return { codeModel: { modelId: state.modelId } };
}

/**
 * The picker's options: "same as my chat model" first, naming the model
 * that is — the preferred chat model while the org still offers it, else
 * the organization default — then every chat model.
 */
export function pickerOptions(
  models: readonly CodeModelOption[],
  chatModelId: string | null
): { value: string; label: string }[] {
  const chat = models.find((model) => model.id === chatModelId) ?? models[0];
  return [
    { value: '', label: `Same as my chat model${chat ? ` (${chat.label})` : ''}` },
    ...models.map((model) => ({ value: model.id, label: `${model.label} · ${model.model}` })),
  ];
}

/** The line under the picker. */
export function pickerHint(models: readonly CodeModelOption[]): string {
  return models.length > 1
    ? 'New chats in a code project start on this model, unless the project names its own; you can still switch in any chat. With none picked they start on your chat model, else the organization default. If an administrator removes it, you are told what replaced it.'
    : 'Your organization has one chat model, so every chat starts on it.';
}
