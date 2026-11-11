/**
 * The Chat model section of Preferences (chat-model-form.tsx), with no
 * network or React. The same form as the image model's beside it — a pick
 * against the one last saved, Save on or off, what a save leaves on screen
 * (image-model-form.model.ts) — over the org's chat models, with its own
 * request and wording. "Organization default" is no preference (null): a
 * new chat then starts on the org's default model, which the page lists
 * first. Tested in chat-model-form.model.test.ts.
 */

import {
  imageModelFormReducer,
  initImageModelForm,
  type ImageModelFormAction,
  type ImageModelFormState,
  type ImageModelOption,
} from './image-model-form.model';

export { canSave, pickerOptions, pickerValue, saveLabel } from './image-model-form.model';

export type ChatModelOption = ImageModelOption;
export type ChatModelFormState = ImageModelFormState;
export type ChatModelFormAction = ImageModelFormAction;

export const initChatModelForm = initImageModelForm;
export const chatModelFormReducer = imageModelFormReducer;

/** What Save PATCHes to /api/preferences. */
export function requestBody(state: ChatModelFormState): { chatModel: { modelId: string | null } } {
  return { chatModel: { modelId: state.modelId } };
}

/** The line under the picker. */
export function pickerHint(models: readonly ChatModelOption[]): string {
  return models.length > 1
    ? 'New chats start on this model, unless their project names its own; you can still switch in any chat. If an administrator removes it, you are told what replaced it.'
    : 'Your organization has one chat model, so every chat starts on it.';
}
