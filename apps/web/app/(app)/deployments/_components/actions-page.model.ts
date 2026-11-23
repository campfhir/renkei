/**
 * The GitHub Actions page's state (actions-page.tsx): the setup as GitHub
 * last answered it, the one open editor of each kind (a variable set as
 * text, a workflow file), what the last change did, and what is in
 * flight. The Bitbucket page's model (pipelines-page.model.ts) is its
 * twin and lends it everything that is the same — the variable text, the
 * removal question, the words under a saved set, a run's pill and
 * duration; what is here is what GitHub changes: many workflow files
 * where Bitbucket has one (so the editor carries a name), secrets that
 * are listed but never set, and no run form.
 *
 * Tested in actions-page.model.test.ts.
 */

import type { PipelineVariable } from '@/lib/code/bitbucket-pipelines';
import type { ActionsSetup, WorkflowFile } from '@/lib/code/github-actions';
import { renderVariableText } from '@/lib/code/pipeline-variables-text';
import { workflowFileName } from '@/lib/code/workflow-file-name';
import {
  askedDraft,
  filledDraft,
  missingIn,
  type PipelineNeeds,
  type Committed,
  type Draft,
  type Outcome,
  type Scope,
  type VariableAsk,
} from './pipelines-page.model';

export interface ActionsPageSetup extends ActionsSetup {
  /** Null when the project has no saved pipeline that reads. */
  pipeline?: PipelineNeeds | null;
  access: {
    /** Why the switch and the variables cannot be changed from here; null when they can. */
    configureNeeds: string | null;
  };
}

/** The workflow file being written: its name, text and commit message. */
export interface WorkflowDraft {
  /** True for a file that is not on the branch yet: its name is still the person's to set. */
  isNew: boolean;
  name: string;
  text: string;
  message: string;
}

export interface ActionsState {
  setup: ActionsPageSetup | null;
  loadError: string | null;
  error: string | null;
  /** Why the variable the page was sent to set could not be opened, or where to set a secret. */
  notice: string | null;
  busy: boolean;
  draft: Draft | null;
  outcome: Outcome | null;
  fileDraft: WorkflowDraft | null;
  committed: (Committed & { name: string }) | null;
}

export const initialActions: ActionsState = {
  setup: null,
  loadError: null,
  error: null,
  notice: null,
  busy: false,
  draft: null,
  outcome: null,
  fileDraft: null,
  committed: null,
};

export type ActionsAction =
  | { type: 'loaded'; setup: ActionsPageSetup }
  | { type: 'loadFailed'; error: string }
  | { type: 'sent'; what: 'flip' | 'variables' | 'file' }
  | { type: 'failed'; error: string }
  | { type: 'flipped' }
  | { type: 'variablesOpened'; scope: Scope; variables: PipelineVariable[] }
  /** The page was sent to set a variable; `canSet` is whether this person may. */
  | { type: 'variableAsked'; ask: VariableAsk; canSet: boolean }
  /** "Add the N it needs": the set's box opened with a line for each plain variable it lacks. */
  | { type: 'missingFilled'; scope: Scope }
  | { type: 'variablesChanged'; text: string }
  | { type: 'variablesCancelled' }
  | { type: 'variablesSaved'; outcome: Outcome | null }
  | { type: 'fileOpening' }
  | { type: 'fileOpenFailed'; error: string }
  | {
      type: 'fileOpened';
      /** The file's name, or null for a new one. */
      name: string | null;
      text: string | null;
    }
  | { type: 'fileChanged'; field: 'name' | 'text' | 'message'; value: string }
  | { type: 'fileCancelled' }
  | { type: 'fileCommitted'; committed: (Committed & { name: string }) | null };

export function actionsReducer(state: ActionsState, action: ActionsAction): ActionsState {
  switch (action.type) {
    case 'loaded':
      return { ...state, setup: action.setup, loadError: null };
    case 'loadFailed':
      return { ...state, loadError: action.error };
    case 'sent':
      return {
        ...state,
        busy: true,
        error: null,
        ...(action.what === 'variables' ? { outcome: null } : {}),
      };
    case 'failed':
      return { ...state, busy: false, error: action.error };
    case 'flipped':
      return { ...state, busy: false };

    case 'variablesOpened':
      return {
        ...state,
        draft: { ...action.scope, text: renderVariableText(action.variables) },
      };
    case 'variableAsked': {
      if (!state.setup) return state;
      if (action.ask.secured) {
        // GitHub secrets are listed here but set only on GitHub.
        return {
          ...state,
          notice: `${action.ask.name} is a secret: GitHub secrets are set on GitHub, under the ${action.ask.environment ? `${action.ask.environment} environment’s` : 'repository’s'} Secrets and variables settings.`,
        };
      }
      const opened = askedDraft(state.setup, action.ask, {
        canSet: action.canSet,
        label: 'GitHub',
      });
      return 'draft' in opened
        ? { ...state, draft: opened.draft, notice: null }
        : { ...state, notice: opened.notice };
    }
    case 'missingFilled': {
      if (!state.setup) return state;
      const variables = action.scope.environmentUuid
        ? state.setup.environments.find((e) => e.uuid === action.scope.environmentUuid)?.variables
        : state.setup.variables;
      const missing = plainMissing(state.setup, action.scope);
      if (!variables || missing.length === 0) return state;
      return { ...state, draft: filledDraft(action.scope, variables, missing), notice: null };
    }
    case 'variablesChanged':
      return state.draft
        ? { ...state, draft: { ...state.draft, text: action.text, caret: undefined } }
        : state;
    case 'variablesCancelled':
      return { ...state, draft: null };
    case 'variablesSaved':
      return { ...state, busy: false, draft: null, notice: null, outcome: action.outcome };

    case 'fileOpening':
      return { ...state, busy: true, error: null, committed: null };
    case 'fileOpenFailed':
      return { ...state, busy: false, error: action.error };
    case 'fileOpened':
      return {
        ...state,
        busy: false,
        fileDraft: {
          isNew: action.name === null,
          name: action.name ?? '',
          text: action.text ?? '',
          message: action.name === null ? 'Add a workflow' : `Update ${action.name}`,
        },
      };
    case 'fileChanged': {
      if (!state.fileDraft) return state;
      const next = { ...state.fileDraft, [action.field]: action.value };
      // A new file's commit message follows its name until the person writes their own.
      if (
        action.field === 'name' &&
        state.fileDraft.isNew &&
        state.fileDraft.message === commitMessageFor(state.fileDraft.name)
      ) {
        next.message = commitMessageFor(action.value);
      }
      return { ...state, fileDraft: next };
    }
    case 'fileCancelled':
      return { ...state, fileDraft: null };
    case 'fileCommitted':
      return { ...state, busy: false, fileDraft: null, committed: action.committed };
  }
}

/** The commit message a new file starts with: its name when it has one. */
export function commitMessageFor(name: string): string {
  const file = workflowFileName(name);
  return file ? `Add ${file}` : 'Add a workflow';
}

// ── The workflow file ──

/** Commit can be pressed: a usable file name, something in the box, nothing in flight. */
export function canCommitWorkflow(state: ActionsState): boolean {
  const draft = state.fileDraft;
  return (
    !state.busy && draft !== null && workflowFileName(draft.name) !== null && !!draft.text.trim()
  );
}

/** What Commit sends: the file's name, the box as it is, and the message trimmed. */
export function workflowRequest(draft: WorkflowDraft): {
  name: string;
  text: string;
  message: string;
} {
  return {
    name: workflowFileName(draft.name) ?? draft.name.trim(),
    text: draft.text,
    message: draft.message.trim(),
  };
}

/** Why a new file's name cannot be used yet; null when it can, or while nothing is typed. */
export function workflowNameProblem(
  draft: WorkflowDraft,
  existing: readonly WorkflowFile[]
): string | null {
  if (!draft.isNew || !draft.name.trim()) return null;
  const name = workflowFileName(draft.name);
  if (!name) return 'A file name like ci.yml: letters, digits, dots, dashes, ending .yml or .yaml.';
  if (existing.some((file) => file.name.toLowerCase() === name.toLowerCase())) {
    return `${name} is already a workflow; edit that one instead.`;
  }
  return null;
}

/** The status after a commit, past the link: a reminder when Actions is off. */
export function committedReminder(state: ActionsState): string {
  return state.setup?.enabled === false ? ' Turn Actions on above to run it.' : '';
}

// ── The page ──

/** An editor may change the switch and the variables only when GitHub lets the grant do so. */
export function canConfigure(state: ActionsState, canEdit: boolean): boolean {
  return canEdit && state.setup?.access.configureNeeds === null;
}

/** The hint under an environment's set. */
export function environmentHint(): string {
  return 'Workflow jobs that deploy to this environment get these as well.';
}

/** The workflows line: how many, or why none could be listed. */
export function workflowsLine(
  setup: Pick<ActionsSetup, 'workflows' | 'workflowsError'>,
  branchLabel: string
): string {
  if (setup.workflows === null) return setup.workflowsError ?? 'Could not be checked.';
  if (setup.workflows.length === 0) return `No workflow files on ${branchLabel} yet.`;
  return `${setup.workflows.length} on ${branchLabel}.`;
}

/** Secrets, said once under a set: where a person adds one. */
export function secretsNote(count: number): string {
  return count === 0
    ? 'Secrets are added on GitHub, where their values are never shown again.'
    : 'Secrets are listed by name; their values are never shown, and are added on GitHub.';
}

/** The project's branch as sentences name it. */
export function branchLabel(branch: string): string {
  return branch || 'the default branch';
}

// ── What the pipeline reads ──

/** The plain variables a set lacks that the pipeline reads there: what its box can add. */
export function plainMissing(
  setup: ActionsPageSetup,
  scope: Scope
): { name: string; secured: boolean }[] {
  return missingIn(setup, setup.pipeline, scope).filter((need) => !need.secured);
}

/** The secrets a set lacks: set on GitHub, so named under the set rather than added to its box. */
export function secretsMissingNote(setup: ActionsPageSetup, scope: Scope): string | null {
  const secrets = missingIn(setup, setup.pipeline, scope).filter((need) => need.secured);
  if (secrets.length === 0) return null;
  return `The pipeline also reads ${secrets.length === 1 ? 'the secret' : 'the secrets'} ${secrets.map((s) => s.name).join(', ')}: set ${secrets.length === 1 ? 'it' : 'them'} on GitHub.`;
}
