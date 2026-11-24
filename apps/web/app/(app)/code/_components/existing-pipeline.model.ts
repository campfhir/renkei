/**
 * A branch's pipeline that was not built here (existing-pipeline.tsx): a
 * `bitbucket-pipelines.yml` or GitHub workflows written in another editor,
 * or before the project came to Renkei. The Pipeline tab opens on it
 * rather than on the builder: the file as it is on the branch, an editor
 * that commits to the branch (by hand, or with the assistant's proposal
 * put into it), the report step that lets it show what it deployed, and —
 * only when asked for — the builder, whose pull request replaces it.
 *
 * Here: which file is open, the edit under way, what Commit sends, and the
 * report step once taken. Tested in existing-pipeline.model.test.ts.
 */

export type ExistingHost = 'bitbucket' | 'github';

export interface ReportStep {
  snippet: string;
  where: string;
  environment: string;
}

export interface ExistingState {
  /** The pipeline files on the branch that the builder did not write, by name. */
  files: string[];
  /** The file open. */
  selected: string | null;
  /** Its text as it is on the branch; null until read. */
  text: string | null;
  loading: boolean;
  /** The edit under way: the box and the commit message. */
  draft: { text: string; message: string } | null;
  busy: boolean;
  error: string | null;
  /** Where the last commit from here went. */
  committed: { ref: string; url: string } | null;
  report: ReportStep | null;
  reportBusy: boolean;
  reportError: string | null;
  copied: boolean;
}

export type ExistingAction =
  | { type: 'opened'; files: string[] }
  | { type: 'picked'; name: string }
  | { type: 'read'; name: string; text: string }
  | { type: 'readFailed'; name: string; error: string }
  | { type: 'editStarted' }
  | { type: 'draftChanged'; field: 'text' | 'message'; value: string }
  | { type: 'editCancelled' }
  /** The assistant's file, put into the editor to be looked over and committed. */
  | { type: 'proposalApplied'; name: string; text: string }
  | { type: 'sent' }
  | { type: 'failed'; error: string }
  | { type: 'committed'; ref: string; url: string }
  | { type: 'reportAsked' }
  | { type: 'reportRead'; step: ReportStep }
  | { type: 'reportFailed'; error: string }
  | { type: 'reportClosed' }
  | { type: 'copied' };

export const initialExisting: ExistingState = {
  files: [],
  selected: null,
  text: null,
  loading: false,
  draft: null,
  busy: false,
  error: null,
  committed: null,
  report: null,
  reportBusy: false,
  reportError: null,
  copied: false,
};

export function existingReducer(state: ExistingState, action: ExistingAction): ExistingState {
  switch (action.type) {
    case 'opened': {
      // The file open stays open when the list is read again; else the first.
      const selected =
        state.selected && action.files.includes(state.selected)
          ? state.selected
          : (action.files[0] ?? null);
      const same = selected === state.selected;
      return {
        ...state,
        files: action.files,
        selected,
        text: same ? state.text : null,
        loading: same ? state.loading : selected !== null,
        draft: same ? state.draft : null,
      };
    }
    case 'picked':
      if (action.name === state.selected || !state.files.includes(action.name)) return state;
      return {
        ...state,
        selected: action.name,
        text: null,
        loading: true,
        draft: null,
        error: null,
        committed: null,
      };
    case 'read':
      // An answer for a file no longer open is dropped.
      return action.name === state.selected
        ? { ...state, text: action.text, loading: false, error: null }
        : state;
    case 'readFailed':
      return action.name === state.selected
        ? { ...state, loading: false, error: action.error }
        : state;
    case 'editStarted':
      return state.text === null || state.draft
        ? state
        : {
            ...state,
            draft: { text: state.text, message: `Update ${state.selected ?? 'the pipeline'}` },
            committed: null,
            error: null,
          };
    case 'draftChanged':
      return state.draft
        ? { ...state, draft: { ...state.draft, [action.field]: action.value } }
        : state;
    case 'editCancelled':
      return { ...state, draft: null, error: null };
    case 'proposalApplied':
      if (action.name !== state.selected) return state;
      return {
        ...state,
        draft: {
          text: action.text,
          message: state.draft?.message ?? `Update ${action.name}`,
        },
        committed: null,
        error: null,
      };
    case 'sent':
      return { ...state, busy: true, error: null };
    case 'failed':
      return { ...state, busy: false, error: action.error };
    case 'committed':
      return {
        ...state,
        busy: false,
        // What was committed is what the branch now has.
        text: state.draft?.text ?? state.text,
        draft: null,
        committed: { ref: action.ref, url: action.url },
      };
    case 'reportAsked':
      return { ...state, reportBusy: true, reportError: null, copied: false };
    case 'reportRead':
      return { ...state, reportBusy: false, report: action.step };
    case 'reportFailed':
      return { ...state, reportBusy: false, reportError: action.error };
    case 'reportClosed':
      return { ...state, report: null, copied: false };
    case 'copied':
      return { ...state, copied: true };
  }
}

/** The text the assistant is asked about: the edit under way, else the file as it is. */
export function fileOnScreen(state: ExistingState): { name: string; text: string } | null {
  if (!state.selected || state.text === null) return null;
  return { name: state.selected, text: state.draft?.text ?? state.text };
}

export function isEdited(state: ExistingState): boolean {
  return state.draft !== null && state.draft.text !== state.text;
}

/** Commit can be pressed: the box differs from the branch, says something, and nothing is in flight. */
export function canCommit(state: ExistingState): boolean {
  return !state.busy && isEdited(state) && !!state.draft?.text.trim();
}

/** Where a file is read from and committed to, on the routes the Runs tab uses. */
export function fileUrl(
  host: ExistingHost,
  projectId: string,
  branch: string,
  name: string
): string {
  const query = new URLSearchParams({ branch });
  if (host === 'github') {
    query.set('name', name);
    return `/api/code/projects/${projectId}/actions/workflow-file?${query.toString()}`;
  }
  return `/api/code/projects/${projectId}/pipelines/config-file?${query.toString()}`;
}

/** What Commit sends: the box as it is, the message trimmed, and — on GitHub — which workflow. */
export function commitRequest(
  state: ExistingState,
  host: ExistingHost
): { text: string; message: string; name?: string } | null {
  if (!state.draft || !state.selected) return null;
  return {
    ...(host === 'github' ? { name: state.selected } : {}),
    text: state.draft.text,
    message: state.draft.message.trim() || `Update ${state.selected}`,
  };
}

/** The file's place in the repository, as a person reads it. */
export function filePath(host: ExistingHost, name: string): string {
  return host === 'github' ? `.github/workflows/${name}` : name;
}

/** What building from blocks does to what is there, said before it is chosen. */
export function buildLabel(host: ExistingHost): string {
  return host === 'github'
    ? 'Add a workflow built from blocks'
    : 'Replace it with one built from blocks';
}

export function buildWarning(
  host: ExistingHost,
  state: Pick<ExistingState, 'files'>,
  branch: string
): string {
  if (host === 'github') {
    return `The builder writes its own workflow, .github/workflows/pipeline.yml, in a pull request against ${branch}. ${
      state.files.includes('pipeline.yml')
        ? 'That replaces the pipeline.yml here; the other workflows stay and still run.'
        : `The ${state.files.length === 1 ? 'workflow' : 'workflows'} here stay${state.files.length === 1 ? 's' : ''} and still run${state.files.length === 1 ? 's' : ''}, so remove what the new one takes over.`
    }`;
  }
  return `The builder writes the whole of bitbucket-pipelines.yml, in a pull request against ${branch}: merging it replaces the file here. The pull request’s diff shows what changes.`;
}

/** A text box's height in rows: its lines plus one, within bounds. */
export function textRows(text: string, min = 10, max = 32): number {
  return Math.max(min, Math.min(max, text.split('\n').length + 1));
}
