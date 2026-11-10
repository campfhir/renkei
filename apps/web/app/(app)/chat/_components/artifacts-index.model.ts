/**
 * The Artifacts page (artifacts-index.tsx): the filters as typed, the
 * file whose details are open (and the copy of it last seen, so its
 * details stay while a page it is not on is shown), select mode and the
 * files ticked in it, which dialog is open, the upload in flight, the
 * one detach in flight, and the error line.
 *
 * The page makes the calls, turns the URL and runs the timers, and
 * dispatches what the person did and what the server answered; what it
 * decides from that — what a press on a row does, what a filter change
 * asks the server for, what the pager and the select toolbar offer, what
 * the details say about where a file is used and who may do what with
 * it, when the page keeps reading itself again — is here, and tested in
 * artifacts-index.model.test.ts.
 */

import type { LibraryItem } from '@/lib/chat/artifact-library';
import type { LibraryFilters, LibraryQuery } from '@/lib/chat/artifact-library-params';
import type { LibraryPage } from '@/lib/chat/artifact-library-query';
import { canRunOcr, isPicture } from './artifact-ocr-panel.model';

export type Dialog = 'share' | 'delete' | 'copy' | 'rename' | 'attach' | 'replace';
export type Bulk = 'add' | 'delete';

/** The upload in flight: which file of how many, and the bytes sent over all of them. */
export interface Transfer {
  count: number;
  /** 1-based. */
  index: number;
  name: string;
  loaded: number;
  bytes: number;
}

export interface IndexState {
  filters: LibraryFilters;
  /** The file whose details are open. */
  selected: string | null;
  /** The selected file as last seen on a page. */
  remembered: LibraryItem | null;
  dragging: boolean;
  transfer: Transfer | null;
  error: string | null;
  dialog: Dialog | null;
  /** Select mode: a press on a row ticks it instead of opening it. */
  selecting: boolean;
  picked: readonly string[];
  bulk: Bulk | null;
  /** The detach in flight, as "file:project". */
  detaching: string | null;
}

export type IndexAction =
  /** The URL changed under the page (the back button): the filters follow it. */
  | { type: 'urlChanged'; filters: LibraryFilters }
  | { type: 'filtered'; patch: Partial<LibraryFilters> }
  | { type: 'selected'; item: LibraryItem | null }
  /** A file to open that is not on this page yet (a copy just made). */
  | { type: 'revealed'; id: string }
  /** The selected file is on the page now: remember it as it is. */
  | { type: 'seenOnPage'; item: LibraryItem }
  | { type: 'pageArrived' }
  | { type: 'dragEntered'; uploads: boolean }
  | { type: 'dragEnded' }
  | { type: 'transferMoved'; transfer: Transfer }
  | { type: 'transferProgress'; loaded: number }
  | { type: 'uploadsAnswered'; failures: string[] }
  /** An act went out: its error line clears. */
  | { type: 'actSent' }
  | { type: 'actAnswered'; error: string | null }
  | { type: 'dialogOpened'; dialog: Dialog }
  | { type: 'dialogClosed' }
  | { type: 'selectModeToggled' }
  | { type: 'pickToggled'; id: string }
  | { type: 'pickedAll'; ids: string[] }
  | { type: 'pickCleared' }
  | { type: 'bulkOpened'; bulk: Bulk }
  | { type: 'bulkClosed' }
  | { type: 'detachSent'; key: string }
  | { type: 'detachFailed'; error: string };

export const filtersOf = (query: LibraryQuery): LibraryFilters => ({
  show: query.show,
  projectId: query.projectId,
  query: query.query,
});

/** The filters as one string: what tells the page's own navigation from the back button. */
export const keyOf = (filters: LibraryFilters): string =>
  `${filters.show}|${filters.projectId ?? ''}|${filters.query}`;

export function initialIndex({
  query,
  items,
  selectedId,
}: {
  query: LibraryQuery;
  items: readonly LibraryItem[];
  selectedId: string | null;
}): IndexState {
  return {
    filters: filtersOf(query),
    selected: selectedId,
    remembered: items.find((item) => item.id === selectedId) ?? null,
    dragging: false,
    transfer: null,
    error: null,
    dialog: null,
    selecting: false,
    picked: [],
    bulk: null,
    detaching: null,
  };
}

const failuresLine = (failures: readonly string[]): string | null =>
  failures.length > 0 ? failures.join('; ') : null;

export function indexReducer(state: IndexState, action: IndexAction): IndexState {
  switch (action.type) {
    case 'urlChanged':
      return { ...state, filters: action.filters };
    case 'filtered':
      return { ...state, filters: { ...state.filters, ...action.patch } };
    case 'selected':
      return {
        ...state,
        selected: action.item?.id ?? null,
        remembered: action.item ?? state.remembered,
      };
    case 'revealed':
      return { ...state, selected: action.id };
    case 'seenOnPage':
      return state.remembered === action.item ? state : { ...state, remembered: action.item };
    case 'pageArrived':
      // A new page is the server's answer to a detach: the one in flight is over.
      return state.detaching === null ? state : { ...state, detaching: null };
    case 'dragEntered':
      return action.uploads && !state.dragging ? { ...state, dragging: true } : state;
    case 'dragEnded':
      return state.dragging ? { ...state, dragging: false } : state;
    case 'transferMoved':
      return { ...state, transfer: action.transfer };
    case 'transferProgress':
      return state.transfer
        ? { ...state, transfer: { ...state.transfer, loaded: action.loaded } }
        : state;
    case 'uploadsAnswered':
      return { ...state, transfer: null, error: failuresLine(action.failures) ?? state.error };
    case 'actSent':
      return { ...state, error: null };
    case 'actAnswered':
      return { ...state, error: action.error ?? state.error };
    case 'dialogOpened':
      return { ...state, dialog: action.dialog };
    case 'dialogClosed':
      return { ...state, dialog: null };
    case 'selectModeToggled':
      return { ...state, selecting: !state.selecting, picked: [] };
    case 'pickToggled':
      return {
        ...state,
        picked: state.picked.includes(action.id)
          ? state.picked.filter((other) => other !== action.id)
          : [...state.picked, action.id],
      };
    case 'pickedAll':
      return { ...state, picked: action.ids };
    case 'pickCleared':
      return { ...state, picked: [] };
    case 'bulkOpened':
      return { ...state, bulk: action.bulk };
    case 'bulkClosed':
      return { ...state, bulk: null };
    case 'detachSent':
      return { ...state, detaching: action.key, error: null };
    case 'detachFailed':
      return { ...state, detaching: null, error: action.error };
  }
}

/**
 * A filter change starts over at the first page of what it shows. The
 * search box waits for typing to pause; a tab or the project asks at once.
 */
export function filterStep(
  state: IndexState,
  patch: Partial<LibraryFilters>
): { filters: LibraryFilters; page: 1; debounce: boolean } {
  return { filters: { ...state.filters, ...patch }, page: 1, debounce: 'query' in patch };
}

/** What a press on a row does: in select mode it ticks; otherwise it opens, or closes what is open. */
export function rowPress(state: IndexState, item: LibraryItem, narrow: boolean): IndexAction {
  if (state.selecting) return { type: 'pickToggled', id: item.id };
  // On a phone the details cover the list, so a row is only ever a way in.
  return { type: 'selected', item: item.id === state.selected && !narrow ? null : item };
}

/** The file whose details show: the one on this page, or the copy last seen of it. */
export function currentItem(state: IndexState, items: readonly LibraryItem[]): LibraryItem | null {
  const onPage = items.find((item) => item.id === state.selected) ?? null;
  return onPage ?? (state.remembered?.id === state.selected ? state.remembered : null);
}

/** The ticked files that are on this page, in the page's order. */
export function pickedItems(state: IndexState, items: readonly LibraryItem[]): LibraryItem[] {
  return items.filter((item) => state.picked.includes(item.id));
}

/** Whether a detach press sends anything: not while the same one is in flight. */
export function detachSends(state: IndexState, key: string): boolean {
  return state.detaching !== key;
}

/** The page to ask for, held inside the pages there are. */
export function clampPage(page: Pick<LibraryPage, 'pageCount'>, toPage: number): number {
  return Math.max(1, Math.min(page.pageCount, toPage));
}

export interface Pager {
  /** "26–34 of 34", or null when nothing matches. */
  range: string | null;
  /** "Page 2 of 2", or null when one page holds everything (no buttons then). */
  pageLabel: string | null;
  previousDisabled: boolean;
  nextDisabled: boolean;
}

export function pager(page: Pick<LibraryPage, 'total' | 'page' | 'pageSize' | 'pageCount'>): Pager {
  const first = page.total === 0 ? 0 : (page.page - 1) * page.pageSize + 1;
  const last = Math.min(page.total, page.page * page.pageSize);
  return {
    range: page.total > 0 ? `${first}–${last} of ${page.total}` : null,
    pageLabel: page.pageCount > 1 ? `Page ${page.page} of ${page.pageCount}` : null,
    previousDisabled: page.page <= 1,
    nextDisabled: page.page >= page.pageCount,
  };
}

/** What an empty list says: nothing at all yet, or nothing matching. */
export function emptyMessage(libraryCount: number, query: string, digests: boolean): string {
  if (libraryCount === 0) {
    return 'No artifacts yet. Upload a manual, a guide or a design doc, or drop one anywhere on this page; files your chats write land here on their own.';
  }
  return query.trim().length > 0 && digests
    ? 'Nothing matches. Search looks at file names and at the summary and keywords written for each file.'
    : 'Nothing matches.';
}

export interface Toolbar {
  /** "2 selected", or the hint while nothing is. */
  label: string;
  anyPicked: boolean;
  /** The ticked files Run OCR asks a read of; it is off when there are none. */
  ocrTargets: LibraryItem[];
}

/** The select-mode toolbar under the list. */
export function toolbar(state: IndexState, items: readonly LibraryItem[]): Toolbar {
  const ticked = pickedItems(state, items);
  return {
    label: ticked.length > 0 ? `${ticked.length} selected` : 'Tap files to select',
    anyPicked: ticked.length > 0,
    ocrTargets: ticked.filter(canRunOcr),
  };
}

/** One line naming every file that failed: "a.pdf: Too big; b.png: Not allowed". */
export function failureLine(failures: readonly string[]): string | null {
  return failuresLine(failures);
}

/** Whether the page keeps reading itself again (artifact-ocr.ts): a read in flight, or a summary
 *  still to come for a file this page saw being read. */
export function keepsReading(
  items: readonly LibraryItem[],
  digests: boolean,
  readHere: ReadonlySet<string>
): boolean {
  const ocrRunning = items.some((item) => item.ocr !== null);
  const summaryAwaited =
    digests &&
    items.some(
      (item) =>
        readHere.has(item.id) &&
        (item.digestStatus === 'pending' || item.digestStatus === 'running')
    );
  return ocrRunning || summaryAwaited;
}

/** The files this page has seen being read, with those being read now added. */
export function seenReading(
  readHere: ReadonlySet<string>,
  items: readonly LibraryItem[]
): Set<string> {
  const next = new Set(readHere);
  for (const item of items) if (item.ocr !== null) next.add(item.id);
  return next;
}

/** What the digest's state says in the details, or null when it says nothing worth a line. */
export function digestLabel(
  item: Pick<LibraryItem, 'digestStatus' | 'contentType'>
): string | null {
  const picture = isPicture(item.contentType);
  switch (item.digestStatus) {
    case 'pending':
    case 'running':
      return picture ? 'Describing the picture…' : 'Summary on its way…';
    case 'failed':
      return picture
        ? 'No description could be written for this picture.'
        : 'No summary could be written for this file.';
    case 'none':
      return picture ? 'Nothing to describe.' : 'No text to summarize.';
    default:
      return null;
  }
}

/** Whether the details have an About section: digests are on, or the file has one anyway. */
export function showsAbout(
  item: Pick<LibraryItem, 'summary' | 'keywords'>,
  digests: boolean
): boolean {
  return digests || item.summary !== null || item.keywords.length > 0;
}

/** Where a row says the file came from and whose it is: " · generated in “Fix rounding” · shared by Priya". */
export function rowOrigin(item: Pick<LibraryItem, 'origin' | 'chat' | 'ownerName'>): string {
  return (
    (item.origin === 'model' ? ' · generated' : item.chat ? ' · uploaded' : '') +
    (item.chat ? ` in “${item.chat.title ?? 'a chat'}”` : '') +
    (item.ownerName ? ` · shared by ${item.ownerName}` : '')
  );
}

/** The projects a wide row names (two at most), and how many more it holds. */
export function rowProjects<P>(projects: readonly P[]): { named: P[]; more: number } {
  return { named: projects.slice(0, 2), more: Math.max(0, projects.length - 2) };
}

/** "generated" or "uploaded", in the details' byline. */
export function originWord(item: Pick<LibraryItem, 'origin'>): string {
  return item.origin === 'model' ? 'generated' : 'uploaded';
}

/** "owned by you", or whose it is. */
export function ownerLabel(item: Pick<LibraryItem, 'via' | 'ownerName'>): string {
  return item.via === 'owner' ? 'owned by you' : `${item.ownerName ?? 'someone'}’s`;
}

/** What "Used in" says when no project holds the file. */
export function usedInNowhere(item: Pick<LibraryItem, 'chat'>): string {
  return item.chat
    ? 'In its chat only; it goes when the chat does unless a project takes it.'
    : 'Not attached to a project.';
}

/** Whether "Attach to a project…" is offered: the viewer has a project, and owns or was given the file. */
export function canAttach(item: Pick<LibraryItem, 'via'>, projectCount: number): boolean {
  return projectCount > 0 && (item.via === 'owner' || item.via === 'grant');
}

/** What the Access section says about who may do what. */
export function accessLine(item: Pick<LibraryItem, 'via' | 'sharedWith' | 'projects'>): string {
  if (item.via === 'owner') {
    const shared =
      item.sharedWith > 0
        ? `; shared with ${item.sharedWith} ${item.sharedWith === 1 ? 'person' : 'people'}`
        : '';
    const projects =
      item.projects.length > 0
        ? 'Everyone in the projects above reads it; their owners and editors may detach it.'
        : '';
    return `You own it${shared}. ${projects}`;
  }
  return item.via === 'grant'
    ? 'Shared with you: use it in your own projects, read it, copy it. Only its owner changes it.'
    : 'You read it through a project or chat it is used in.';
}

export interface Acts {
  /** Share, Replace, Rename and Delete: the owner's. */
  owner: boolean;
  /** Make a copy: anyone else's. */
  copy: boolean;
  /** Remove from my artifacts: a person it was shared with. */
  leave: boolean;
  /** The line under the acts. */
  note: string;
}

/** The acts the details offer this viewer (artifact-access.ts). */
export function acts(item: Pick<LibraryItem, 'via'>): Acts {
  const owner = item.via === 'owner';
  return {
    owner,
    copy: !owner,
    leave: item.via === 'grant',
    note: owner
      ? 'Replacing keeps every attachment and re-reads the text. Deleting shows who loses it and offers to hand it over instead.'
      : 'A copy is a separate file you own; the owner is told. Removing it keeps their file and their shares.',
  };
}
