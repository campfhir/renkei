/**
 * A library's prompt editor (library-view.tsx): the title and text being
 * written, what Save sends and when it may, the questions the text asks,
 * and Refine — a dialog (prompt-refine-modal.tsx) with the draft on the
 * left and a model's rewrite on the right, asked for the moment it opens
 * when there is a draft (with none, it waits for the editor to say what
 * the prompt is for, and drafts it). A prompt under them steers Try again,
 * and Accept takes the rewrite into the field, still unsaved until Save.
 * Tested in prompt-editor.model.test.ts.
 */

import type { ModelOption } from '@/lib/chat/views';
import { parsePromptVariables } from '@/lib/chat/prompt-variables';

export interface EditedPrompt {
  id: string;
  title: string;
  body: string;
}

export interface PromptProposal {
  body: string;
  /** A suggested title, only when the editor had none. */
  title: string | null;
}

export interface PromptRefineState {
  open: boolean;
  /** An ask waits for the roster: the dialog asks the moment it opens. */
  queued: boolean;
  /** What the editor wants changed — or, with no draft, what the prompt is for. */
  guidance: string;
  /** The chat roster, once loaded; null before. */
  models: ModelOption[] | null;
  modelId: string | null;
  asking: boolean;
  proposal: PromptProposal | null;
  error: string | null;
}

export interface PromptEditorState {
  /** What the editor is open on: a new prompt, one of the library's, or nothing. */
  target: 'new' | { id: string } | null;
  title: string;
  body: string;
  busy: boolean;
  error: string | null;
  /** The text last taken from a proposal, while it is still what the field says. */
  accepted: string | null;
  refine: PromptRefineState;
}

const closedRefine: PromptRefineState = {
  open: false,
  queued: false,
  guidance: '',
  models: null,
  modelId: null,
  asking: false,
  proposal: null,
  error: null,
};

export const initialEditor: PromptEditorState = {
  target: null,
  title: '',
  body: '',
  busy: false,
  error: null,
  accepted: null,
  refine: closedRefine,
};

export type PromptEditorAction =
  | { type: 'opened'; prompt: EditedPrompt | 'new' }
  | { type: 'closed' }
  | { type: 'titleTyped'; text: string }
  | { type: 'bodyTyped'; text: string }
  | { type: 'saveStarted' }
  | { type: 'saveFailed'; error: string }
  | { type: 'saved' }
  | { type: 'refineOpened' }
  | { type: 'refineClosed' }
  | { type: 'modelsLoaded'; models: ModelOption[] }
  | { type: 'modelPicked'; modelId: string }
  | { type: 'guidanceTyped'; text: string }
  | { type: 'refineStarted' }
  | { type: 'refineFailed'; error: string }
  | { type: 'refineAnswered'; proposal: PromptProposal }
  | { type: 'proposalAccepted' };

/** The roster and the model chosen outlive a dialog: the next one starts from them. */
function keptRefine(state: PromptEditorState): PromptRefineState {
  return { ...closedRefine, models: state.refine.models, modelId: state.refine.modelId };
}

export function promptEditorReducer(
  state: PromptEditorState,
  action: PromptEditorAction
): PromptEditorState {
  switch (action.type) {
    case 'opened':
      return {
        ...initialEditor,
        target: action.prompt === 'new' ? 'new' : { id: action.prompt.id },
        title: action.prompt === 'new' ? '' : action.prompt.title,
        body: action.prompt === 'new' ? '' : action.prompt.body,
        refine: keptRefine(state),
      };
    case 'closed':
    case 'saved':
      return { ...initialEditor, refine: keptRefine(state) };
    case 'titleTyped':
      return { ...state, title: action.text };
    case 'bodyTyped':
      return { ...state, body: action.text };
    case 'saveStarted':
      return { ...state, busy: true, error: null };
    case 'saveFailed':
      return { ...state, busy: false, error: action.error };
    case 'refineOpened':
      if (state.target === null || state.refine.open || state.busy) return state;
      return {
        ...state,
        refine: {
          ...keptRefine(state),
          open: true,
          // With a draft the dialog asks as it opens; with none it waits to be told what to write.
          queued: state.body.trim() !== '',
        },
      };
    case 'refineClosed':
      return { ...state, refine: keptRefine(state) };
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
        body: proposal.body,
        title: titleToTake(state) ?? state.title,
        accepted: proposal.body,
        refine: keptRefine(state),
      };
    }
  }
}

/** The editor is open on a prompt. */
export function editorOpen(state: PromptEditorState): boolean {
  return state.target !== null;
}

/** Save needs a title and some text, and not a save or a rewrite already under way. */
export function canSave(state: PromptEditorState): boolean {
  return (
    state.title.trim() !== '' && state.body.trim() !== '' && !state.busy && !state.refine.asking
  );
}

/** What Save sends. */
export function saveBody(state: PromptEditorState): { title: string; body: string } {
  return { title: state.title.trim(), body: state.body.trim() };
}

/** There is no text yet: Refine writes a prompt from a description instead of rewriting one. */
export function drafting(state: PromptEditorState): boolean {
  return state.body.trim() === '';
}

/** The editor's own button. */
export function refineButtonLabel(state: PromptEditorState): string {
  return drafting(state) ? 'Draft with AI' : 'Refine';
}

/** The dialog's title. */
export function refineHeading(state: PromptEditorState): string {
  return drafting(state) ? 'Draft prompt' : 'Refine prompt';
}

/** There is something to work on — a draft, or a description of the prompt — and no ask is under way. */
export function canRefine(state: PromptEditorState): boolean {
  return !state.refine.asking && (state.body.trim() !== '' || state.refine.guidance.trim() !== '');
}

/** What Refine sends: the title and draft as they stand, what was asked for, the model chosen. */
export function refineBody(state: PromptEditorState): {
  title: string;
  body: string;
  guidance?: string;
  llmModelId?: string;
} {
  const guidance = state.refine.guidance.trim();
  return {
    title: state.title.trim(),
    body: state.body.trim(),
    ...(guidance ? { guidance } : {}),
    ...(state.refine.modelId ? { llmModelId: state.refine.modelId } : {}),
  };
}

/** The text cannot be typed in while a rewrite of it is on its way. */
export function bodyLocked(state: PromptEditorState): boolean {
  return state.refine.asking;
}

/** The title the proposal would fill in: only an empty title takes one. */
export function titleToTake(state: PromptEditorState): string | null {
  const suggested = state.refine.proposal?.title ?? null;
  return suggested && state.title.trim() === '' ? suggested : null;
}

/** The proposal says the same as the draft and has no title to add: nothing to take. */
export function proposalUnchanged(state: PromptEditorState): boolean {
  const proposal = state.refine.proposal;
  return (
    proposal !== null && proposal.body.trim() === state.body.trim() && titleToTake(state) === null
  );
}

/** The dialog is open with its first ask waiting, and the roster has come. */
export function shouldAskNow(state: PromptEditorState): boolean {
  return (
    state.refine.open && state.refine.queued && state.refine.models !== null && canRefine(state)
  );
}

/** The dialog's own button: a first ask, a working one, or another go. */
export function askLabel(state: PromptEditorState): string {
  const writing = drafting(state);
  if (state.refine.asking || state.refine.queued) return writing ? 'Drafting…' : 'Refining…';
  if (state.refine.proposal || state.refine.error) return 'Try again';
  return writing ? 'Draft' : 'Refine';
}

/** What the guidance field asks of the editor. */
export function guidanceLabel(state: PromptEditorState): string {
  return drafting(state)
    ? 'What is this prompt for? Say what it should do, then draft it.'
    : 'Anything to change? Say what, then try again.';
}

/** Accept takes a finished rewrite that differs from the draft. */
export function canAccept(state: PromptEditorState): boolean {
  return state.refine.proposal !== null && !state.refine.asking && !proposalUnchanged(state);
}

/** What the editor says after a rewrite was taken, until it is saved or changed again. */
export function refinedNote(state: PromptEditorState): string | null {
  return state.accepted !== null && state.body === state.accepted
    ? 'Refined, not saved yet. Save to keep it.'
    : null;
}

const TYPE_WORDS = {
  text: 'Short text',
  longtext: 'Long text',
  number: 'Number',
  date: 'Date',
  choice: 'Choose one',
  multi: 'Choose several',
} as const;

export interface QuestionRow {
  name: string;
  label: string;
  /** "Choose one · security, performance · required" */
  detail: string;
}

export interface PromptQuestions {
  rows: QuestionRow[];
  /** What in the prompt's variables could not be read, in the parser's words. */
  problems: string[];
}

/** The questions a prompt asks when it is picked, from the same reading the form uses. */
export function promptQuestions(body: string): PromptQuestions {
  const parsed = parsePromptVariables(body);
  return {
    rows: parsed.fields.map((field) => ({
      name: field.name,
      label: field.label,
      detail: [
        TYPE_WORDS[field.type],
        field.options ? field.options.join(', ') : null,
        field.required ? 'required' : null,
      ]
        .filter((part): part is string => part !== null)
        .join(' · '),
    })),
    problems: parsed.problems,
  };
}

/** "Asks 3 questions" — what the editor says under the text, or null when it asks none. */
export function questionsSummary(body: string): string | null {
  const count = promptQuestions(body).rows.length;
  if (count === 0) return null;
  return `Asks ${count} ${count === 1 ? 'question' : 'questions'} when picked.`;
}
