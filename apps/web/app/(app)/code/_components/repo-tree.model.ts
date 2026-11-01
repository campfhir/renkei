/**
 * The code pane's file tree (repo-tree.tsx): the folders as last listed,
 * which are open, where the listing came from, the one New file / Rename
 * dialog, and a failed move.
 *
 * The component reads the folders, sends the creates, renames, moves and
 * deletes, and handles the drags; everything the tree decides from what
 * it has — what a dialog's name sends or refuses, which rows are dimmed,
 * which ghosts a folder shows, what a row's "⋯" menu offers, where a drop
 * or a move lands — is here, and tested in repo-tree.model.test.ts.
 */

export interface Entry {
  path: string;
  kind: 'file' | 'dir' | 'link' | 'other';
  sizeBytes: number | null;
  ignored?: boolean;
}

export type Listing =
  { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; entries: Entry[] };

export type Source = 'checkout' | 'bitbucket' | 'github';

/** How the working tree has a file: modified against HEAD, added (untracked), or gone. */
export type FileMark = 'M' | 'A' | 'D';

export type Dialog =
  | { kind: 'new-file'; folder: string; name: string }
  | { kind: 'rename'; path: string; name: string };

export interface TreeState {
  listings: Record<string, Listing>;
  open: Record<string, boolean>;
  /** null until the first listing answers. */
  source: Source | null;
  dialog: Dialog | null;
  busy: boolean;
  dialogError: string | null;
  moveError: string | null;
}

export type TreeAction =
  /** A folder is being read with its loading line showing. */
  | { type: 'loading'; path: string }
  | { type: 'listed'; path: string; entries: Entry[]; source: Source }
  | { type: 'listFailed'; path: string; message: string }
  /** A folder row pressed: open becomes closed and closed open. */
  | { type: 'toggled'; path: string }
  /** A folder shown open because something just landed in it. */
  | { type: 'revealed'; folder: string }
  | { type: 'newFile'; folder: string }
  | { type: 'rename'; path: string }
  | { type: 'nameChanged'; name: string }
  | { type: 'dialogClosed' }
  /** The dialog's name was refused before anything was sent. */
  | { type: 'refused'; error: string }
  | { type: 'sent' }
  /** The create or rename was refused by the server: the dialog stays, with why. */
  | { type: 'failed'; error: string }
  /** The create or rename went through; a new file's folder opens to show it. */
  | { type: 'done'; folder: string }
  | { type: 'moveStarted' }
  | { type: 'moveFailed'; path: string; error: string };

export const initialTree: TreeState = {
  listings: {},
  open: {},
  source: null,
  dialog: null,
  busy: false,
  dialogError: null,
  moveError: null,
};

export function nameOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? path : path.slice(index + 1);
}

export function folderOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

/** A path under a folder ('' is the root). */
export function under(folder: string, name: string): string {
  return folder ? `${folder}/${name}` : name;
}

export function treeReducer(state: TreeState, action: TreeAction): TreeState {
  switch (action.type) {
    case 'loading':
      return { ...state, listings: { ...state.listings, [action.path]: { state: 'loading' } } };
    case 'listed':
      return {
        ...state,
        source: action.source,
        listings: { ...state.listings, [action.path]: { state: 'ready', entries: action.entries } },
      };
    case 'listFailed':
      return {
        ...state,
        listings: {
          ...state.listings,
          [action.path]: { state: 'error', message: action.message },
        },
      };
    case 'toggled':
      return { ...state, open: { ...state.open, [action.path]: !state.open[action.path] } };
    case 'revealed':
      if (!action.folder || state.open[action.folder]) return state;
      return { ...state, open: { ...state.open, [action.folder]: true } };
    case 'newFile':
      return {
        ...state,
        dialogError: null,
        dialog: { kind: 'new-file', folder: action.folder, name: '' },
      };
    case 'rename':
      return {
        ...state,
        dialogError: null,
        dialog: { kind: 'rename', path: action.path, name: nameOf(action.path) },
      };
    case 'nameChanged':
      if (!state.dialog) return state;
      return { ...state, dialog: { ...state.dialog, name: action.name } };
    case 'dialogClosed':
      return { ...state, dialog: null, busy: false };
    case 'refused':
      return { ...state, dialogError: action.error };
    case 'sent':
      return { ...state, busy: true, dialogError: null };
    case 'failed':
      return { ...state, busy: false, dialogError: action.error };
    case 'done': {
      const opened = treeReducer(
        { ...state, busy: false, dialog: null },
        {
          type: 'revealed',
          folder: action.folder,
        }
      );
      return opened;
    }
    case 'moveStarted':
      return { ...state, moveError: null };
    case 'moveFailed':
      return { ...state, moveError: `${nameOf(action.path)}: ${action.error}` };
  }
}

/** Pressing a folder row reads it when it opens and was never read. */
export function toggleReads(state: TreeState, path: string): boolean {
  return !state.open[path] && !state.listings[path];
}

/** What the dialog's Create or Rename does with the name as typed. */
export type Submission =
  | { kind: 'refused'; error: string }
  | { kind: 'create'; folder: string; body: { path: string } }
  | { kind: 'rename'; folder: string; body: { from: string; to: string } }
  /** A rename to the same name: the dialog just closes. */
  | { kind: 'unchanged' };

export function submission(dialog: Dialog): Submission {
  const trimmed = dialog.name.trim();
  if (!trimmed) {
    return {
      kind: 'refused',
      error: dialog.kind === 'new-file' ? 'Say what to call it.' : 'Say the new name.',
    };
  }
  // The server refuses ".." too (validateWorkspacePath); this is the
  // same rule without the round trip.
  if (trimmed.split('/').some((part) => part === '..')) {
    return { kind: 'refused', error: 'A path cannot leave the workspace ("..").' };
  }
  if (dialog.kind === 'new-file') {
    // A trailing "/" is kept: the route makes a folder for it.
    return { kind: 'create', folder: dialog.folder, body: { path: under(dialog.folder, trimmed) } };
  }
  const folder = folderOf(dialog.path);
  const to = under(folder, trimmed);
  if (to === dialog.path) return { kind: 'unchanged' };
  return { kind: 'rename', folder, body: { from: dialog.path, to } };
}

/** Rows can be changed only in a checkout, and only by someone who may edit. */
export function canWrite(state: TreeState, canEdit: boolean): boolean {
  return canEdit && state.source === 'checkout';
}

/** A download reads the checkout: anyone who sees the tree, once there is one. */
export function canDownload(state: TreeState): boolean {
  return state.source === 'checkout';
}

export type MenuAction = 'new-file' | 'rename' | 'download' | 'delete';

/** What a row's "⋯" offers, in order; null when the row has no menu. */
export function rowMenu(
  kind: Entry['kind'],
  can: { write: boolean; download: boolean }
): MenuAction[] | null {
  if (!can.download) return null;
  if (kind === 'dir') {
    return can.write ? ['new-file', 'rename', 'download', 'delete'] : ['download'];
  }
  if (kind === 'file') return can.write ? ['rename', 'download', 'delete'] : ['download'];
  return null;
}

/** A row's Download: a file as itself, a folder as a zip. */
export function downloadLink(
  archiveBase: string,
  path: string,
  kind: 'file' | 'dir'
): { label: string; href: string; filename: string } {
  return {
    label: kind === 'dir' ? 'Download as zip' : 'Download',
    href: `${archiveBase}?path=${encodeURIComponent(path)}`,
    filename: kind === 'dir' ? `${nameOf(path)}.zip` : nameOf(path),
  };
}

/** What Delete asks before it goes. */
export function deletePrompt(path: string, kind: Entry['kind']): string {
  const label = kind === 'dir' ? `“${nameOf(path)}” and everything in it` : `“${nameOf(path)}”`;
  return `Delete ${label}? This can't be undone.`;
}

/**
 * A row is dimmed when the host reports it gitignored or any folder
 * above it is: a folder's listing does not always repeat the flag for
 * what is inside an ignored folder.
 */
export function rowIgnored(insideIgnored: boolean, entry: Entry): boolean {
  return insideIgnored || entry.ignored === true;
}

/** Files the working tree deleted in `folder`, drawn as struck-through rows, by name. */
export function ghostsFor(
  marks: ReadonlyMap<string, FileMark> | undefined,
  folder: string
): string[] {
  if (!marks) return [];
  const result: string[] = [];
  for (const [path, mark] of marks) {
    if (mark === 'D' && folderOf(path) === folder) result.push(path);
  }
  return result.sort((a, b) => a.localeCompare(b));
}

export function markTitle(mark: FileMark): string {
  return mark === 'A'
    ? 'Added, not committed'
    : mark === 'D'
      ? 'Deleted, not committed'
      : 'Changed, not committed';
}

export function sizeLabel(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1_048_576) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1_048_576).toFixed(1)} MB`;
}

/** `path` may move into `folder`: not into itself, under itself, or where it already is. */
export function canMoveInto(path: string, folder: string): boolean {
  if (folderOf(path) === folder) return false;
  if (folder === path || folder.startsWith(`${path}/`)) return false;
  return true;
}

/** The rename a row dropped on `folder` sends; null when it stays where it is. */
export function moveRequest(path: string, folder: string): { from: string; to: string } | null {
  if (!canMoveInto(path, folder)) return null;
  return { from: path, to: under(folder, nameOf(path)) };
}

/** Files dropped from outside the page on `folder`: where each lands, and the batch's title. */
export function dropUpload(folder: string, names: string[]): { title: string; paths: string[] } {
  return {
    title: `Add files to ${folder || 'the repository root'}`,
    paths: names.map((name) => under(folder, name)),
  };
}
