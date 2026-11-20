/**
 * The Pipelines page's state (pipelines-page.tsx): the setup as Bitbucket
 * last answered it, the one open editor of each kind (a variable set as
 * text, the pipeline file, the "Run pipeline" form), what the last change
 * did (a run started, a file committed, a set applied), and what is in
 * flight.
 *
 * The component makes the calls and dispatches what the person did and
 * what the server answered; everything the page decides from that — which
 * variables a save takes away (and the question it asks first), what each
 * request sends, when Commit and Start run can be pressed, the words
 * under a saved set, how a run's state
 * and duration read — is here, and tested in pipelines-page.model.test.ts.
 */

import type {
  DeploymentEnvironment,
  PipelineRun,
  PipelineSetup,
  PipelineVariable,
  VariablesApplied,
} from '@/lib/code/bitbucket-pipelines';
import {
  renderVariableText,
  withVariableLine,
  type Caret,
} from '@/lib/code/pipeline-variables-text';

export interface Setup extends PipelineSetup {
  access: {
    /** Why the switch cannot be flipped from here; null when it can. */
    configureNeeds: string | null;
    /** Why variables cannot be set from here; null when they can. */
    variablesNeeds: string | null;
  };
}

/** Which set a box writes to: the repository's, or one environment's. */
export type Scope = { environmentUuid?: string };

/** One set being edited as text. */
export interface Draft extends Scope {
  text: string;
  /** Where the cursor goes when the box opens on a variable it was sent to set. */
  caret?: Caret;
}

/**
 * A variable the page was sent to set (the builder's "Set it":
 * `?set=NAME&in=ENVIRONMENT&secret=1`): which, where — an environment by
 * name, or null for the repository's own set — and whether it is a secret.
 */
export interface VariableAsk {
  name: string;
  environment: string | null;
  secured: boolean;
}

/** The ask a link carries, read from its query; null when it names no usable variable. */
export function readVariableAsk(query: { get(key: string): string | null }): VariableAsk | null {
  const name = query.get('set')?.trim() ?? '';
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) return null;
  const environment = query.get('in')?.trim() || null;
  return { name, environment, secured: query.get('secret') === '1' };
}

type AskedSets = {
  variables: PipelineVariable[];
  environments: { uuid: string; name: string; variables: PipelineVariable[] }[];
};

/**
 * The box an ask opens, on the variable's line with the cursor placed —
 * or why it cannot open: an environment the host does not have, or no
 * right to set variables here.
 */
export function askedDraft(
  sets: AskedSets,
  ask: VariableAsk,
  host: { canSet: boolean; label: string }
): { draft: Draft } | { notice: string } {
  if (!host.canSet) {
    return {
      notice: `${ask.name} is not set; you cannot set variables here, so ask an editor of the project.`,
    };
  }
  const environment = ask.environment
    ? sets.environments.find((e) => e.name.toLowerCase() === ask.environment!.toLowerCase())
    : null;
  if (ask.environment && !environment) {
    return {
      notice: `${host.label} has no deployment environment named ${ask.environment}, so ${ask.name} cannot be set for it yet: add the environment on ${host.label}, then set it there.`,
    };
  }
  const variables = environment ? environment.variables : sets.variables;
  const ready = withVariableLine(renderVariableText(variables), ask.name, ask.secured);
  return {
    draft: {
      ...(environment ? { environmentUuid: environment.uuid } : {}),
      text: ready.text,
      caret: ready.caret,
    },
  };
}

/** What the last save of a set did, shown under it until the next edit. */
export interface Outcome extends Scope, VariablesApplied {
  problems: string[];
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
  /** Why the variable the page was sent to set could not be opened. */
  notice: string | null;
  busy: boolean;
  draft: Draft | null;
  outcome: Outcome | null;
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
  notice: null,
  busy: false,
  draft: null,
  outcome: null,
  runDraft: null,
  started: null,
  fileDraft: null,
  committed: null,
};

export type PipelinesAction =
  | { type: 'loaded'; setup: Setup }
  | { type: 'loadFailed'; error: string }
  /** A change went out: the switch, a variable set, a run, or the file. */
  | { type: 'sent'; what: 'flip' | 'variables' | 'run' | 'file' }
  /** A change was refused; every editor stays as it was. */
  | { type: 'failed'; error: string }
  | { type: 'flipped' }
  // The variable sets
  | { type: 'variablesOpened'; scope: Scope; variables: PipelineVariable[] }
  /** The page was sent to set a variable; `canSet` is whether this person may. */
  | { type: 'variableAsked'; ask: VariableAsk; canSet: boolean }
  | { type: 'variablesChanged'; text: string }
  | { type: 'variablesCancelled' }
  | { type: 'variablesSaved'; outcome: Outcome | null }
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
        ...(action.what === 'variables' ? { outcome: null } : {}),
        ...(action.what === 'run' ? { started: null } : {}),
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
      const opened = askedDraft(state.setup, action.ask, {
        canSet: action.canSet,
        label: 'Bitbucket',
      });
      return 'draft' in opened
        ? { ...state, draft: opened.draft, notice: null }
        : { ...state, notice: opened.notice };
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

// ── The variable sets ──

/** The keys a box's text names, as the server will read them (`secret`/`export` prefixes allowed). */
export function keysInText(text: string): Set<string> {
  return new Set(
    text
      .split(/\r?\n/)
      .map(
        (line) =>
          /^\s*(?:secret|secured)?\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[=:]/i.exec(line)?.[1]
      )
      .filter((key): key is string => Boolean(key))
  );
}

/** The variables a save of this text takes away: every one whose line is gone. */
export function variablesGoing(text: string, current: PipelineVariable[]): PipelineVariable[] {
  const keys = keysInText(text);
  return current.filter((variable) => !keys.has(variable.key));
}

/**
 * What a save asks first when it takes variables away — a secured value
 * cannot be brought back once its line is gone; null when nothing goes.
 */
export function removalQuestion(going: PipelineVariable[]): string | null {
  if (going.length === 0) return null;
  return `Remove ${going.map((variable) => variable.key).join(', ')}? Pipeline runs will no longer see ${going.length === 1 ? 'it' : 'them'}.`;
}

/** What Save sends for a set: the text, and which environment's set it is. */
export function variablesRequest(draft: Draft): { text: string; environmentUuid?: string } {
  return {
    text: draft.text,
    ...(draft.environmentUuid ? { environmentUuid: draft.environmentUuid } : {}),
  };
}

/** The outcome a saved set shows: the server's answer, tied to the box it came from. */
export function outcomeOf(
  draft: Draft,
  answer: VariablesApplied & { problems: string[] }
): Outcome {
  return {
    ...answer,
    ...(draft.environmentUuid ? { environmentUuid: draft.environmentUuid } : {}),
  };
}

function isHere(candidate: Scope | null, scope: Scope): boolean {
  return candidate !== null && (candidate.environmentUuid ?? '') === (scope.environmentUuid ?? '');
}

/** The open box, when it is this set's. */
export function draftFor(state: Pick<PipelinesState, 'draft'>, scope: Scope): Draft | null {
  return isHere(state.draft, scope) ? state.draft : null;
}

/** The last save's outcome, when it was this set's. */
export function outcomeFor(state: Pick<PipelinesState, 'outcome'>, scope: Scope): Outcome | null {
  return isHere(state.outcome, scope) ? state.outcome : null;
}

/** The lines under a saved set. */
export function outcomeLines(outcome: Outcome): {
  /** "added A, B · changed C." — or "Nothing changed." when it was a no-op and nothing went wrong. */
  status: string | null;
  notApplied: string | null;
  notRead: string | null;
} {
  const parts = [
    outcome.added.length ? `added ${outcome.added.join(', ')}` : '',
    outcome.changed.length ? `changed ${outcome.changed.join(', ')}` : '',
    outcome.removed.length ? `removed ${outcome.removed.join(', ')}` : '',
  ].filter(Boolean);
  return {
    status: parts.length
      ? `${parts.join(' · ')}.`
      : outcome.errors.length === 0 && outcome.problems.length === 0
        ? 'Nothing changed.'
        : null,
    notApplied: outcome.errors.length ? `Not applied: ${outcome.errors.join('; ')}` : null,
    notRead: outcome.problems.length
      ? `Not read as variables: ${outcome.problems.join('; ')}.`
      : null,
  };
}

/** The set's button: Add when there is nothing yet, Edit otherwise. */
export function variablesButtonLabel(variables: PipelineVariable[]): string {
  return variables.length ? 'Edit variables' : 'Add variables';
}

/** How a variable reads in its row: Secured, its value, or (empty). */
export function variableShown(variable: PipelineVariable): { secured: true } | { value: string } {
  return variable.secured ? { secured: true } : { value: variable.value || '(empty)' };
}

/** An editor may set variables only when Bitbucket lets the grant do so. */
export function canSetVariables(state: PipelinesState, canEdit: boolean): boolean {
  return canEdit && state.setup?.access.variablesNeeds === null;
}

/** The hint under an environment's set. */
export function environmentHint(environment: Pick<DeploymentEnvironment, 'type'>): string {
  return `Runs deploying to this ${environment.type ? environment.type.toLowerCase() + ' ' : ''}environment get these as well.`;
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
