/**
 * A branch's Bitbucket Pipelines runs (pipelines-page.tsx, the Runs tab
 * of a branch on the Environments page): the setup as Bitbucket last
 * answered it, the one open editor of each kind (the pipeline file, the
 * "Run pipeline" form), what the last change did (a run started, a file
 * committed), and what is in flight.
 *
 * The component makes the calls and dispatches what the person did and
 * what the server answered; everything the page decides from that — what
 * each request sends, when Commit and Start run can be pressed, how a
 * run's state and duration read — is here, and tested in
 * pipelines-page.model.test.ts. Variables are the Variables tab's
 * (variables-editor.model.ts).
 */

import type { PipelineRun, PipelineSetup } from '@/lib/code/bitbucket-pipelines';

export interface Setup extends PipelineSetup {
  access: {
    /** Why the switch cannot be flipped from here; null when it can. */
    configureNeeds: string | null;
    /** Why variables cannot be set from here; null when they can. */
    variablesNeeds: string | null;
  };
}

/** The pipeline file being written: its text and the commit message. */
export interface FileDraft {
  text: string;
  message: string;
}

/** The "Run pipeline" form: where, and which pipeline. */
export interface RunDraft {
  ref: string;
  refType: 'branch' | 'tag';
  pattern: string;
}

export interface Committed {
  ref: string;
  url: string;
}

export interface PipelinesState {
  /** null until the first read answers. */
  setup: Setup | null;
  loadError: string | null;
  /** The last change Bitbucket refused. */
  error: string | null;
  busy: boolean;
  runDraft: RunDraft | null;
  /** The run just started from here, named until the next start. */
  started: PipelineRun | null;
  fileDraft: FileDraft | null;
  /** Where the file just committed from here went, until the editor opens again. */
  committed: Committed | null;
}

export const initialPipelines: PipelinesState = {
  setup: null,
  loadError: null,
  error: null,
  busy: false,
  runDraft: null,
  started: null,
  fileDraft: null,
  committed: null,
};

export type PipelinesAction =
  | { type: 'loaded'; setup: Setup }
  | { type: 'loadFailed'; error: string }
  /** A change went out: the switch, a run, or the file. */
  | { type: 'sent'; what: 'flip' | 'run' | 'file' }
  /** A change was refused; every editor stays as it was. */
  | { type: 'failed'; error: string }
  | { type: 'flipped' }
  // The pipeline file
  | { type: 'fileOpening' }
  | { type: 'fileOpenFailed'; error: string }
  | { type: 'fileOpened'; text: string | null }
  | { type: 'fileChanged'; field: 'text' | 'message'; value: string }
  | { type: 'fileCancelled' }
  | { type: 'fileCommitted'; committed: Committed | null }
  // Starting a run
  | { type: 'runOpened'; defaultRef: string }
  | { type: 'runChanged'; field: 'ref' | 'pattern'; value: string }
  | { type: 'runTypeChanged'; value: string }
  | { type: 'runCancelled' }
  | { type: 'runStarted'; run: PipelineRun | null };

export function pipelinesReducer(state: PipelinesState, action: PipelinesAction): PipelinesState {
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
        ...(action.what === 'run' ? { started: null } : {}),
      };
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
          text: action.text ?? '',
          message:
            action.text === null ? 'Add bitbucket-pipelines.yml' : 'Update bitbucket-pipelines.yml',
        },
      };
    case 'fileChanged':
      return state.fileDraft
        ? { ...state, fileDraft: { ...state.fileDraft, [action.field]: action.value } }
        : state;
    case 'fileCancelled':
      return { ...state, fileDraft: null };
    case 'fileCommitted':
      return { ...state, busy: false, fileDraft: null, committed: action.committed };

    case 'runOpened':
      return { ...state, runDraft: { ref: action.defaultRef, refType: 'branch', pattern: '' } };
    case 'runChanged':
      return state.runDraft
        ? { ...state, runDraft: { ...state.runDraft, [action.field]: action.value } }
        : state;
    case 'runTypeChanged':
      return state.runDraft
        ? {
            ...state,
            runDraft: { ...state.runDraft, refType: action.value === 'tag' ? 'tag' : 'branch' },
          }
        : state;
    case 'runCancelled':
      return { ...state, runDraft: null };
    case 'runStarted':
      return { ...state, busy: false, runDraft: null, started: action.run };
  }
}

/** A text box's height in rows: its lines plus one, within bounds. */
export function textRows(text: string, min: number, max: number): number {
  return Math.max(min, Math.min(max, text.split('\n').length + 1));
}

// ── The pipeline file ──

/** Commit can be pressed: something is in the box and nothing is in flight. */
export function canCommit(state: PipelinesState): boolean {
  return !state.busy && state.fileDraft !== null && !!state.fileDraft.text.trim();
}

/** What Commit sends: the box as it is, and the message trimmed. */
export function fileRequest(draft: FileDraft): { text: string; message: string } {
  return { text: draft.text, message: draft.message.trim() };
}

/** The status after a commit, past the link: a reminder when Pipelines is off. */
export function committedReminder(state: PipelinesState): string {
  return state.setup?.enabled === false ? ' Turn Pipelines on above to run it.' : '';
}

// ── Runs ──

/** "Run pipeline" is offered to an editor while Pipelines is not known to be off. */
export function canRun(state: PipelinesState, canEdit: boolean): boolean {
  return canEdit && state.setup !== null && state.setup.enabled !== false;
}

/** Start run can be pressed: a branch or tag is named and nothing is in flight. */
export function canStartRun(state: PipelinesState): boolean {
  return !state.busy && state.runDraft !== null && !!state.runDraft.ref.trim();
}

/** What Start run sends: the ref and the custom pipeline trimmed (empty for the ref's default). */
export function runRequest(draft: RunDraft): RunDraft {
  return { ref: draft.ref.trim(), refType: draft.refType, pattern: draft.pattern.trim() };
}

/** How long a run took, at the coarseness that reads: 45s, 5m 12s, 2h 3m. */
export function duration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export type Tone = 'green' | 'red' | 'blue' | 'gray';

/** A run's state as its pill reads: green passed, red failed, blue while it runs; Bitbucket's word in sentence case. */
export function runStatePill(state: string): { tone: Tone; label: string } {
  const upper = state.toUpperCase();
  const tone: Tone =
    upper === 'SUCCESSFUL' || upper === 'PASSED'
      ? 'green'
      : upper === 'FAILED' || upper === 'ERROR'
        ? 'red'
        : upper === 'IN_PROGRESS' || upper === 'RUNNING' || upper === 'PENDING'
          ? 'blue'
          : 'gray';
  const label = state
    ? state.charAt(0) + state.slice(1).toLowerCase().replace(/_/g, ' ')
    : 'Unknown';
  return { tone, label };
}

// ── The page ──

/** The repository's Pipelines on bitbucket.org; null when the name is not `workspace/slug`. */
export function pipelinesUrl(repoFullName: string): string | null {
  const [workspace, repoSlug] = repoFullName.split('/');
  return workspace && repoSlug
    ? `https://bitbucket.org/${encodeURIComponent(workspace)}/${encodeURIComponent(repoSlug)}/pipelines`
    : null;
}

/** The project's branch as sentences name it. */
export function branchLabel(branch: string): string {
  return branch || 'the default branch';
}
