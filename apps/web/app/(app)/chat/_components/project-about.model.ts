/**
 * A project page's About section (project-view.tsx): the name,
 * description and instructions being edited, what Save sends and when it
 * may, the header's quick rename, and Refine — a dialog (refine-modal.tsx)
 * with the draft on the left and a model's rewrite on the right, asked
 * for the moment it opens; a prompt under them steers Try again, and
 * Accept takes the rewrite into the field (still unsaved until Save).
 * Tested in project-about.model.test.ts.
 */

import type { ModelOption } from '@/lib/chat/views';

export interface AboutFields {
  name: string;
  description: string;
  instructions: string;
}

export interface RefineProposal {
  instructions: string;
}

export interface RefineState {
  open: boolean;
  /** An ask waits for the roster: the dialog asks the moment it opens. */
  queued: boolean;
  /** What the editor wants changed ("shorter", "add a section on tone"). */
  guidance: string;
  /** The chat roster, once loaded; null before. */
  models: ModelOption[] | null;
  modelId: string | null;
  asking: boolean;
  proposal: RefineProposal | null;
  error: string | null;
}

export interface AboutState {
  /** What the server holds, as the field shows it ('' for none). */
  saved: AboutFields;
  fields: AboutFields;
  saving: boolean;
  saveError: string | null;
  /** When the last save landed (the component's clock); null before one. */
  savedAt: number | null;
  /** The text last taken from a proposal, while it is still what the field says. */
  accepted: string | null;
  refine: RefineState;
}

export interface AboutProject {
  name: string;
  description: string | null;
  instructions: string | null;
}

const closedRefine: RefineState = {
  open: false,
  queued: false,
  guidance: '',
  models: null,
  modelId: null,
  asking: false,
  proposal: null,
  error: null,
};

export function initialAbout(input: {
  project: AboutProject;
  /** What the instructions field starts as when the project has none (a code project's brief). */
  defaultInstructions: string | null;
}): AboutState {
  const { project } = input;
  const saved = {
    name: project.name,
    description: project.description ?? '',
    instructions: project.instructions ?? '',
  };
  return {
    saved,
    fields: { ...saved, instructions: project.instructions ?? input.defaultInstructions ?? '' },
    saving: false,
    saveError: null,
    savedAt: null,
    accepted: null,
    refine: closedRefine,
  };
}

export type AboutAction =
  | { type: 'fieldTyped'; field: keyof AboutFields; value: string }
  | { type: 'saveStarted' }
  | { type: 'saveFailed'; error: string }
  | { type: 'saved'; at: number }
  /** The header's own rename, which saves the name alone. */
  | { type: 'renameSaved'; name: string; at: number }
  | { type: 'renameFailed'; error: string }
  | { type: 'renameCancelled' }
  | { type: 'refineOpened' }
  | { type: 'refineClosed' }
  | { type: 'modelsLoaded'; models: ModelOption[] }
  | { type: 'modelPicked'; modelId: string }
  | { type: 'guidanceTyped'; text: string }
  | { type: 'refineStarted' }
  | { type: 'refineFailed'; error: string }
  | { type: 'refineAnswered'; proposal: RefineProposal }
  /** The proposal goes into the field; Save still keeps it. */
  | { type: 'proposalAccepted' };

const trimmed = (fields: AboutFields): AboutFields => ({
  name: fields.name.trim(),
  description: fields.description.trim(),
  instructions: fields.instructions.trim(),
});

export function aboutReducer(state: AboutState, action: AboutAction): AboutState {
  switch (action.type) {
    case 'fieldTyped':
      return { ...state, fields: { ...state.fields, [action.field]: action.value } };
    case 'saveStarted':
      return { ...state, saving: true, saveError: null };
    case 'saveFailed':
      return { ...state, saving: false, saveError: action.error };
    case 'saved': {
      // What the server stored: the fields trimmed, as the route trims them.
      const stored = trimmed(state.fields);
      return {
        ...state,
        saved: stored,
        fields: stored,
        saving: false,
        savedAt: action.at,
        accepted: null,
      };
    }
    case 'renameSaved':
      return {
        ...state,
        saved: { ...state.saved, name: action.name },
        fields: { ...state.fields, name: action.name },
        saving: false,
        savedAt: action.at,
        saveError: null,
      };
    case 'renameFailed':
      return {
        ...state,
        fields: { ...state.fields, name: state.saved.name },
        saving: false,
        saveError: action.error,
      };
    case 'renameCancelled':
      return { ...state, fields: { ...state.fields, name: state.saved.name } };
    case 'refineOpened':
      if (state.refine.open || !canRefine(state)) return state;
      return {
        ...state,
        refine: {
          ...closedRefine,
          models: state.refine.models,
          modelId: state.refine.modelId,
          open: true,
          queued: true,
        },
      };
    case 'refineClosed':
      // Closing keeps the roster and the chosen model for the next time.
      return {
        ...state,
        refine: { ...closedRefine, models: state.refine.models, modelId: state.refine.modelId },
      };
    case 'modelsLoaded': {
      const keep = action.models.some((model) => model.id === state.refine.modelId);
      const fallback =
        action.models.find((model) => model.isDefault)?.id ?? action.models[0]?.id ?? null;
      return {
        ...state,
        refine: {
          ...state.refine,
          models: action.models,
          modelId: keep ? state.refine.modelId : fallback,
        },
      };
    }
    case 'modelPicked':
      return { ...state, refine: { ...state.refine, modelId: action.modelId } };
    case 'guidanceTyped':
      return { ...state, refine: { ...state.refine, guidance: action.text } };
    case 'refineStarted':
      if (!canRefine(state)) return state;
      return {
        ...state,
        refine: { ...state.refine, asking: true, queued: false, error: null, proposal: null },
      };
    case 'refineFailed':
      // An answer to an ask the person has walked away from (Cancel) is dropped.
      if (!state.refine.asking) return state;
      return { ...state, refine: { ...state.refine, asking: false, error: action.error } };
    case 'refineAnswered':
      if (!state.refine.asking) return state;
      return { ...state, refine: { ...state.refine, asking: false, proposal: action.proposal } };
    case 'proposalAccepted': {
      const proposal = state.refine.proposal;
      if (!proposal || !canAccept(state)) return state;
      return {
        ...state,
        fields: { ...state.fields, instructions: proposal.instructions },
        accepted: proposal.instructions,
        refine: { ...closedRefine, models: state.refine.models, modelId: state.refine.modelId },
      };
    }
  }
}

/** Something in the form differs from what the server holds. */
export function isDirty(state: AboutState): boolean {
  const { fields, saved } = state;
  return (
    fields.name !== saved.name ||
    fields.description !== saved.description ||
    fields.instructions !== saved.instructions
  );
}

export function canSave(state: AboutState): boolean {
  return isDirty(state) && !state.saving && state.fields.name.trim() !== '';
}

/** What Save sends: the fields trimmed, an empty description or instructions as none. */
export function saveBody(state: AboutState): {
  name: string;
  description: string | null;
  instructions: string | null;
} {
  const fields = trimmed(state.fields);
  return {
    name: fields.name,
    description: fields.description || null,
    instructions: fields.instructions || null,
  };
}

/** Refine has something to work on and is not already asking. */
export function canRefine(state: AboutState): boolean {
  return state.fields.instructions.trim() !== '' && !state.refine.asking;
}

/** What Refine sends: the draft as it stands, what the editor asked for, the model chosen. */
export function refineBody(state: AboutState): {
  instructions: string;
  guidance?: string;
  llmModelId?: string;
} {
  const guidance = state.refine.guidance.trim();
  return {
    instructions: state.fields.instructions.trim(),
    ...(guidance ? { guidance } : {}),
    ...(state.refine.modelId ? { llmModelId: state.refine.modelId } : {}),
  };
}

/** The field cannot be typed in while a rewrite of it is on its way. */
export function instructionsLocked(state: AboutState): boolean {
  return state.refine.asking;
}

/** The proposal says the same as the draft: nothing to take. */
export function proposalUnchanged(state: AboutState): boolean {
  const proposal = state.refine.proposal;
  return proposal !== null && proposal.instructions.trim() === state.fields.instructions.trim();
}

/** The field holds a refined text Save has not kept yet. */
export function refinedUnsaved(state: AboutState): boolean {
  return (
    state.accepted !== null &&
    state.fields.instructions === state.accepted &&
    state.fields.instructions !== state.saved.instructions
  );
}

/** The dialog is open with its first ask waiting, and the roster has come. */
export function shouldAskNow(state: AboutState): boolean {
  return (
    state.refine.open && state.refine.queued && state.refine.models !== null && canRefine(state)
  );
}

/** The prompt's own button: a first ask, a working one, or another go. */
export function askLabel(state: AboutState): 'Refine' | 'Refining…' | 'Try again' {
  if (state.refine.asking || state.refine.queued) return 'Refining…';
  return state.refine.proposal || state.refine.error ? 'Try again' : 'Refine';
}

/** Accept takes a finished rewrite that differs from the draft. */
export function canAccept(state: AboutState): boolean {
  return state.refine.proposal !== null && !state.refine.asking && !proposalUnchanged(state);
}
