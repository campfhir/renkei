/**
 * A project's Artifacts card (artifacts-card.tsx): the files the page
 * gave it, less any taken off before the server has said so, a page of
 * ten at a time, the uploads in flight, the one row whose mode is being
 * set, and the error line.
 *
 * The card makes the calls and dispatches what the person did and what
 * the server answered; what it shows from that — which rows, the pager's
 * range and ends, the counts under the list, whether a second press on a
 * row's remove button sends anything — is here, and tested in
 * artifacts-card.model.test.ts.
 */

/** Rows the list shows at once. */
export const ARTIFACTS_PAGE_SIZE = 10;

/** The fields of a project's file the card decides anything from. */
export interface CardFile {
  id: string;
  mode: 'always' | 'on_demand';
}

export interface CardState {
  /** Files taken off the list before the server has said so. */
  removing: readonly string[];
  /** 1-based; held inside the list as it shrinks (a detach on the last page). */
  pageAsked: number;
  /** Uploads not yet answered. */
  uploading: number;
  /** The row whose mode is being set. */
  busyId: string | null;
  error: string | null;
  /** The library picker is open. */
  picking: boolean;
  /** A file is being dragged over the card. */
  dragging: boolean;
}

export type CardAction =
  /** The page's data came again: anything taken off is now the server's word. */
  | { type: 'serverAnswered' }
  | { type: 'pageTurned'; page: number }
  | { type: 'uploadStarted'; count: number }
  | { type: 'fileUploaded'; name: string; error: string | null }
  | { type: 'modeSent'; id: string }
  | { type: 'modeAnswered'; error: string | null }
  | { type: 'detachSent'; id: string }
  | { type: 'detachAnswered'; id: string; error: string | null }
  | { type: 'pickerOpened' }
  | { type: 'pickerClosed' }
  | { type: 'dragOver'; canEdit: boolean }
  | { type: 'dragLeft' };

export const initialCard: CardState = {
  removing: [],
  pageAsked: 1,
  uploading: 0,
  busyId: null,
  error: null,
  picking: false,
  dragging: false,
};

export function cardReducer(state: CardState, action: CardAction): CardState {
  switch (action.type) {
    case 'serverAnswered':
      return state.removing.length === 0 ? state : { ...state, removing: [] };
    case 'pageTurned':
      return { ...state, pageAsked: Math.max(1, action.page) };
    case 'uploadStarted':
      return { ...state, error: null, uploading: action.count };
    case 'fileUploaded':
      return {
        ...state,
        uploading: Math.max(0, state.uploading - 1),
        error: action.error ? `${action.name}: ${action.error}` : state.error,
      };
    case 'modeSent':
      return { ...state, busyId: action.id, error: null };
    case 'modeAnswered':
      return { ...state, busyId: null, error: action.error ?? state.error };
    case 'detachSent':
      if (state.removing.includes(action.id)) return state;
      return { ...state, removing: [...state.removing, action.id], error: null };
    case 'detachAnswered':
      if (!action.error) return state;
      // Refused: the row comes back, with why.
      return {
        ...state,
        error: action.error,
        removing: state.removing.filter((id) => id !== action.id),
      };
    case 'pickerOpened':
      return { ...state, picking: true };
    case 'pickerClosed':
      return { ...state, picking: false };
    case 'dragOver':
      return action.canEdit && !state.dragging ? { ...state, dragging: true } : state;
    case 'dragLeft':
      return state.dragging ? { ...state, dragging: false } : state;
  }
}

/** Whether a remove press sends anything: not for a row already on its way off. */
export function detachSends(state: CardState, id: string): boolean {
  return !state.removing.includes(id);
}

/** The files the card lists: the page's, less the ones taken off. */
export function listedFiles<F extends CardFile>(state: CardState, serverFiles: readonly F[]): F[] {
  return serverFiles.filter((file) => !state.removing.includes(file.id));
}

export interface CardPage<F> {
  /** The page shown: the one asked for, held inside the list as it shrinks. */
  page: number;
  pageCount: number;
  shown: F[];
  /** "11–12 of 12", or null when everything fits on one page and the pager goes. */
  range: string | null;
  previousDisabled: boolean;
  nextDisabled: boolean;
}

/** One page of the listed files, and the pager under it. */
export function cardPage<F>(files: readonly F[], pageAsked: number): CardPage<F> {
  const pageCount = Math.max(1, Math.ceil(files.length / ARTIFACTS_PAGE_SIZE));
  const page = Math.min(Math.max(1, pageAsked), pageCount);
  const firstIndex = (page - 1) * ARTIFACTS_PAGE_SIZE;
  const shown = files.slice(firstIndex, firstIndex + ARTIFACTS_PAGE_SIZE);
  return {
    page,
    pageCount,
    shown,
    range:
      pageCount > 1 ? `${firstIndex + 1}–${firstIndex + shown.length} of ${files.length}` : null,
    previousDisabled: page <= 1,
    nextDisabled: page >= pageCount,
  };
}

/** "none attached" or "3 attached", beside the heading. */
export function attachedLabel(count: number): string {
  return count === 0 ? 'none attached' : `${count} attached`;
}

/** The Upload button's words. */
export function uploadLabel(state: CardState): string {
  return state.uploading > 0 ? `Uploading ${state.uploading}…` : 'Upload';
}

export interface BudgetLine {
  alwaysCount: number;
  /** "1 file" / "2 files". */
  alwaysFiles: string;
  onDemandCount: number;
  /** How full the always-in-context bar is, 0–100. */
  percent: number;
  /** The bar turns amber from here. */
  nearlyFull: boolean;
}

/** The always-in-context line under the list. */
export function budgetLine(
  files: readonly CardFile[],
  tokens: { used: number; budget: number }
): BudgetLine {
  const onDemandCount = files.filter((file) => file.mode === 'on_demand').length;
  const alwaysCount = files.length - onDemandCount;
  const percent = Math.min(100, Math.round((tokens.used / Math.max(1, tokens.budget)) * 100));
  return {
    alwaysCount,
    alwaysFiles: `${alwaysCount} file${alwaysCount === 1 ? '' : 's'}`,
    onDemandCount,
    percent,
    nearlyFull: percent >= 90,
  };
}
