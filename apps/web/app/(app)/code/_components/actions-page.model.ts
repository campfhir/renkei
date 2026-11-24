/**
 * A branch's GitHub Actions runs (actions-page.tsx, the Runs tab of a
 * branch on the Environments page): the setup as GitHub last answered
 * it, the open workflow-file editor, what the last change did, and what
 * is in flight. The Bitbucket panel's model (pipelines-page.model.ts) is
 * its twin; what is here is what GitHub changes: many workflow files
 * where Bitbucket has one (so the editor carries a name), and no run
 * form. Variables and secrets are the Variables tab's
 * (variables-editor.model.ts).
 *
 * Tested in actions-page.model.test.ts.
 */

import type { ActionsSetup, WorkflowFile } from '@/lib/code/github-actions';
import { workflowFileName } from '@/lib/code/workflow-file-name';
import type { Committed } from './pipelines-page.model';

export interface ActionsPageSetup extends ActionsSetup {
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
  busy: boolean;
  fileDraft: WorkflowDraft | null;
  committed: (Committed & { name: string }) | null;
}

export const initialActions: ActionsState = {
  setup: null,
  loadError: null,
  error: null,
  busy: false,
  fileDraft: null,
  committed: null,
};

export type ActionsAction =
  | { type: 'loaded'; setup: ActionsPageSetup }
  | { type: 'loadFailed'; error: string }
  | { type: 'sent'; what: 'flip' | 'file' }
  | { type: 'failed'; error: string }
  | { type: 'flipped' }
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
      return { ...state, busy: true, error: null };
    case 'failed':
      return { ...state, busy: false, error: action.error };
    case 'flipped':
      return { ...state, busy: false };

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

/** An editor may change the switch only when GitHub lets the grant do so. */
export function canConfigure(state: ActionsState, canEdit: boolean): boolean {
  return canEdit && state.setup?.access.configureNeeds === null;
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

/** The project's branch as sentences name it. */
export function branchLabel(branch: string): string {
  return branch || 'the default branch';
}
