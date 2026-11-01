/**
 * The code pane's Commit dialog (commit-dialog.tsx): which changed files
 * are ticked, the message, a new branch or not, and — once committed —
 * the hash and whether it was pushed.
 *
 * The component makes the commit and push calls and dispatches their
 * answers; what a commit sends or refuses, how the ticks follow the
 * working tree, what each row is tagged and what the buttons say are
 * here, tested in commit-dialog.model.test.ts.
 */

export interface ChangedRow {
  path: string;
  status: string;
  added: number;
  deleted: number;
}

export interface Committed {
  branch: string;
  sha: string;
  subject: string;
}

export interface CommitState {
  selected: ReadonlySet<string>;
  /** The paths listed last, ticked or not: one not among them starts ticked. */
  seen: ReadonlySet<string>;
  subject: string;
  body: string;
  newBranch: boolean;
  branchName: string;
  busy: boolean;
  error: string | null;
  committed: Committed | null;
  pushed: { remoteBranch: string } | null;
  /** The file whose diff is unfolded. */
  diffOpen: string | null;
}

export type CommitAction =
  /** The working tree's changed files, as they are now. */
  | { type: 'changed'; files: ChangedRow[] }
  | { type: 'toggle'; path: string; on: boolean }
  | { type: 'all'; files: ChangedRow[] }
  | { type: 'none' }
  | { type: 'subject'; value: string }
  | { type: 'body'; value: string }
  | { type: 'newBranch'; on: boolean }
  | { type: 'branchName'; value: string }
  | { type: 'diff'; path: string }
  | { type: 'refused'; error: string }
  | { type: 'sent' }
  | { type: 'failed'; error: string }
  | { type: 'committed'; commit: Committed }
  | { type: 'pushed'; remoteBranch: string };

/** Opens with every changed file ticked. */
export function initialCommit(files: ChangedRow[]): CommitState {
  return {
    selected: new Set(files.map((file) => file.path)),
    seen: new Set(files.map((file) => file.path)),
    subject: '',
    body: '',
    newBranch: false,
    branchName: '',
    busy: false,
    error: null,
    committed: null,
    pushed: null,
    diffOpen: null,
  };
}

export function commitReducer(state: CommitState, action: CommitAction): CommitState {
  switch (action.type) {
    case 'changed': {
      // A file that turns up while the dialog is open (a save) starts
      // ticked; one that is no longer changed drops off. A file the
      // person unticked stays unticked however often the list refreshes.
      const paths = new Set(action.files.map((file) => file.path));
      const selected = new Set([...state.selected].filter((path) => paths.has(path)));
      for (const path of paths) if (!state.seen.has(path)) selected.add(path);
      return { ...state, selected, seen: paths };
    }
    case 'toggle': {
      const selected = new Set(state.selected);
      if (action.on) selected.add(action.path);
      else selected.delete(action.path);
      return { ...state, selected };
    }
    case 'all':
      return { ...state, selected: new Set(action.files.map((file) => file.path)) };
    case 'none':
      return { ...state, selected: new Set() };
    case 'subject':
      return { ...state, subject: action.value };
    case 'body':
      return { ...state, body: action.value };
    case 'newBranch':
      return { ...state, newBranch: action.on };
    case 'branchName':
      return { ...state, branchName: action.value };
    case 'diff':
      return { ...state, diffOpen: state.diffOpen === action.path ? null : action.path };
    case 'refused':
      return { ...state, error: action.error };
    case 'sent':
      return { ...state, busy: true, error: null };
    case 'failed':
      return { ...state, busy: false, error: action.error };
    case 'committed':
      return { ...state, busy: false, committed: action.commit };
    case 'pushed':
      return { ...state, busy: false, pushed: { remoteBranch: action.remoteBranch } };
  }
}

/** The ticked files' line counts, together. */
export function selectedTotals(
  state: CommitState,
  files: ChangedRow[]
): { added: number; deleted: number } {
  return files
    .filter((file) => state.selected.has(file.path))
    .reduce(
      (sum, file) => ({ added: sum.added + file.added, deleted: sum.deleted + file.deleted }),
      { added: 0, deleted: 0 }
    );
}

/** What Commit sends, or why it does not. */
export function commitRequest(
  state: CommitState,
  files: ChangedRow[]
):
  | { ok: false; error: string }
  | { ok: true; body: { message: string; paths?: string[]; newBranch?: string } } {
  const subject = state.subject.trim();
  if (!subject) return { ok: false, error: 'Write a commit message.' };
  if (state.selected.size === 0) return { ok: false, error: 'Pick at least one file.' };
  const branchName = state.branchName.trim();
  if (state.newBranch && !branchName) return { ok: false, error: 'Name the new branch.' };
  // Every file ticked commits the whole tree; otherwise the ticked paths.
  const all = files.length > 0 && state.selected.size === files.length;
  return {
    ok: true,
    body: {
      message: [subject, state.body.trim()].filter(Boolean).join('\n\n'),
      ...(all ? {} : { paths: [...state.selected] }),
      ...(state.newBranch ? { newBranch: branchName } : {}),
    },
  };
}

/** The Commit button: off with nothing ticked, and counting what is. */
export function commitButton(state: CommitState): { label: string; disabled: boolean } {
  const count = state.selected.size;
  return {
    label: state.busy ? 'Committing…' : `Commit ${count} file${count === 1 ? '' : 's'}`,
    disabled: state.busy || count === 0,
  };
}

/** "Files · 1 of 3 selected". */
export function filesHeading(state: CommitState, files: ChangedRow[]): string {
  return `Files · ${state.selected.size} of ${files.length} selected`;
}

/** Unsaved edits are not on disk and so not in the commit: the dialog says so. */
export function unsavedNotice(dirtyPaths: string[]): string | null {
  if (dirtyPaths.length === 0) return null;
  return dirtyPaths.length === 1
    ? '1 file has unsaved edits, which are not part of a commit.'
    : `${dirtyPaths.length} files have unsaved edits, which are not part of a commit.`;
}

/** Who the page knows changed a file: this browser's save first, then the chat's tools. */
export function whoTag(
  path: string,
  editedHere: ReadonlySet<string>,
  chatPaths: ReadonlySet<string>
): 'edited here' | 'by the chat' | null {
  if (editedHere.has(path)) return 'edited here';
  if (chatPaths.has(path)) return 'by the chat';
  return null;
}

/** The ask to the chat, after a commit: push too unless that is done. */
export function askLabel(state: CommitState): string {
  return state.pushed
    ? 'Ask the chat to open a pull request'
    : 'Ask the chat to push and open a pull request';
}
