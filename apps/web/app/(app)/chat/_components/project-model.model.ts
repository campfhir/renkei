/**
 * A project's own model (project-model.tsx): the model new chats in the
 * project start on, for a chat project and a code project alike. "No
 * model of its own" (null) leaves each new chat to its owner's preferred
 * model, else the organization's default. A pick is saved as it is made;
 * a refused save puts the picker back and says why.
 */

export interface ProjectModelOption {
  id: string;
  label: string;
  model: string;
}

export interface ProjectModelState {
  /** The org's chat models; null until they load. */
  models: readonly ProjectModelOption[] | null;
  /** What the picker shows: the pick on its way, else what is stored. */
  modelId: string | null;
  /** What the server last stored. */
  saved: string | null;
  saving: boolean;
  error: string | null;
}

export function initProjectModel(project: { llmModelId: string | null }): ProjectModelState {
  return {
    models: null,
    modelId: project.llmModelId,
    saved: project.llmModelId,
    saving: false,
    error: null,
  };
}

export type ProjectModelAction =
  | { type: 'modelsLoaded'; models: readonly ProjectModelOption[] }
  /** The picker's value: '' is no model of its own. */
  | { type: 'picked'; value: string }
  | { type: 'saved' }
  | { type: 'saveFailed'; error: string | null | undefined };

export function projectModelReducer(
  state: ProjectModelState,
  action: ProjectModelAction
): ProjectModelState {
  switch (action.type) {
    case 'modelsLoaded':
      return { ...state, models: action.models };
    case 'picked':
      return { ...state, modelId: action.value || null, saving: true, error: null };
    case 'saved':
      return { ...state, saved: state.modelId, saving: false };
    case 'saveFailed':
      return {
        ...state,
        modelId: state.saved,
        saving: false,
        error: action.error || 'Could not save the model',
      };
  }
}

/** The section shows once the models are known and there is one to pick. */
export function showsPicker(state: ProjectModelState): boolean {
  return (state.models?.length ?? 0) > 0;
}

/** The picker's value: '' for no model of its own, or for one no longer on offer. */
export function pickerValue(state: ProjectModelState): string {
  const id = state.modelId;
  return id && (state.models ?? []).some((model) => model.id === id) ? id : '';
}

export const NO_MODEL_LABEL = 'Each person’s preferred model, else the organization default';

export function pickerOptions(state: ProjectModelState): { value: string; label: string }[] {
  return [
    { value: '', label: NO_MODEL_LABEL },
    ...(state.models ?? []).map((model) => ({
      value: model.id,
      label: `${model.label} · ${model.model}`,
    })),
  ];
}

/** What a pick PATCHes to the project. */
export function requestBody(value: string): { llmModelId: string | null } {
  return { llmModelId: value || null };
}
