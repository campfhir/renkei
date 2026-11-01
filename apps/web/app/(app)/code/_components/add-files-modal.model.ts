/**
 * The Add files dialog (add-files-modal.tsx): where the files go, the
 * folder, the files picked so far, and — once Add is pressed — which
 * batch of the upload queue it is watching.
 *
 * The component holds the File objects' input, enqueues the batch and
 * draws the queue's table; what a pick adds, what each file's path will
 * be, what the button says and what batch Add sends are here, tested in
 * add-files-modal.model.test.ts.
 */

/** The table's rows: every file, or the failures (upload-queue.model.ts's UploadFilter). */
export type UploadFilter = 'all' | 'failed';

export type AddFilesDestination = 'checkout' | 'artifacts';

/** What the dialog needs of a picked file. */
export interface PickedFile {
  name: string;
  size: number;
}

export interface AddFilesState<F extends PickedFile = PickedFile> {
  destination: AddFilesDestination;
  folder: string;
  files: F[];
  /** The batch Add started, while the dialog shows its table. */
  batchId: string | null;
  filter: UploadFilter;
}

export type AddFilesAction<F extends PickedFile = PickedFile> =
  | { type: 'destination'; destination: AddFilesDestination }
  | { type: 'folder'; folder: string }
  | { type: 'picked'; files: F[] }
  | { type: 'removed'; file: F }
  | { type: 'started'; batchId: string }
  | { type: 'filter'; filter: UploadFilter }
  /** "Add more": back to choosing, the table's filter reset. */
  | { type: 'addMore' };

export function initialAddFiles<F extends PickedFile>(): AddFilesState<F> {
  return { destination: 'checkout', folder: '', files: [], batchId: null, filter: 'all' };
}

export function addFilesReducer<F extends PickedFile>(
  state: AddFilesState<F>,
  action: AddFilesAction<F>
): AddFilesState<F> {
  switch (action.type) {
    case 'destination':
      return { ...state, destination: action.destination };
    case 'folder':
      return { ...state, folder: action.folder };
    case 'picked': {
      if (action.files.length === 0) return state;
      // A name already on the list is not added twice.
      const names = new Set(state.files.map((file) => file.name));
      const fresh: F[] = [];
      for (const file of action.files) {
        if (names.has(file.name)) continue;
        names.add(file.name);
        fresh.push(file);
      }
      return { ...state, files: [...state.files, ...fresh] };
    }
    case 'removed':
      return { ...state, files: state.files.filter((file) => file !== action.file) };
    case 'started':
      return { ...state, batchId: action.batchId, files: [] };
    case 'filter':
      return { ...state, filter: action.filter };
    case 'addMore':
      return { ...state, batchId: null, filter: 'all' };
  }
}

/** The path a file lands at in the checkout: its name under the folder, if any. */
export function checkoutPath(folder: string, name: string): string {
  const prefix = folder.trim().replace(/^\/+|\/+$/g, '');
  return prefix ? `${prefix}/${name}` : name;
}

/** How a picked file is listed: its checkout path, or its bare name for artifacts. */
export function listedAs(state: AddFilesState, name: string): string {
  return state.destination === 'checkout' ? checkoutPath(state.folder, name) : name;
}

export function canAdd(state: AddFilesState): boolean {
  return state.files.length > 0;
}

/** The Add button's words, with the count once there is more than one. */
export function addLabel(state: AddFilesState): string {
  const base = state.destination === 'checkout' ? 'Add to repository' : 'Add to artifacts';
  return state.files.length > 1 ? `${base} (${state.files.length})` : base;
}

/** The footer's count of picked files; null with none. */
export function countLabel(state: AddFilesState): string | null {
  const count = state.files.length;
  if (count === 0) return null;
  return `${count} file${count === 1 ? '' : 's'}`;
}

/** The batch Add hands the queue: its title, and each file's label and checkout path. */
export function batchPlan<F extends PickedFile>(
  state: AddFilesState<F>,
  projectName: string
): {
  title: string;
  destination: AddFilesDestination;
  items: { file: F; label: string; path: string }[];
} {
  const toCheckout = state.destination === 'checkout';
  return {
    title: toCheckout
      ? `Add files to the checkout of ${projectName}`
      : `Add artifacts to ${projectName}`,
    destination: state.destination,
    items: state.files.map((file) => {
      const path = checkoutPath(state.folder, file.name);
      return { file, path, label: toCheckout ? path : `${file.name} → artifacts` };
    }),
  };
}
