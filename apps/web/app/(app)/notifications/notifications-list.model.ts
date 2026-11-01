/**
 * The notification feed's state (notifications-list.tsx): the older pages
 * "Show more" fetched, the rows deleted this visit, read state changed this
 * visit, the selection, the open row menu, the delete confirmation, and
 * what is in flight.
 *
 * The server page hands the component the newest PAGE_SIZE rows (`rows`),
 * re-queried on every refresh; they are never copied into this state, so
 * every selector that needs them takes them as an argument. The component
 * makes the calls and dispatches what the person did and what the server
 * answered; everything the feed decides from that — which rows show, which
 * read as unread, what the banner says, what each request sends, what a
 * refused delete leaves on screen, where a row's link goes — is here, and
 * tested in notifications-list.model.test.ts.
 */

import { isRecord, isString } from '@renkei/guards';
import {
  batchNotificationHref,
  batchNotificationProgress,
  isBatchNotificationKind,
  parseBatchNotificationMeta,
  type BatchNotificationMeta,
} from '@/lib/notifications/batch-meta';

export interface NotificationCard {
  id: string;
  /**
   * 'run_started' | 'run_finished' | 'run_failed' | 'act' | 'agent_edited' |
   * 'agent_disabled' | 'batch_started' | 'batch_finished' | 'batch_failed' |
   * 'approval' | 'question' | 'chat_shared' | 'agent_shared' | 'chat_reply' |
   * 'chat_permission' | 'artifact_shared' | 'artifact_copied' | 'artifact_transferred'.
   */
  kind: string;
  connector: string | null;
  /** Singular noun for the linked thing — 'issue', 'note', 'meeting', 'batch'. */
  entity: string | null;
  headline: string;
  refUrl: string | null;
  agentId: string | null;
  agentName: string | null;
  runId: string | null;
  /** Batch-job rows carry their counts here — see lib/notifications/batch-meta.ts. */
  meta: unknown;
  unread: boolean;
  /** ISO timestamp — serialized by the server page. */
  createdAt: string;
}

/** One row as the polling/paging API (app/api/notifications/route.ts) shapes it. */
export interface NotificationApiRow {
  id: string;
  kind: string;
  connector: string | null;
  entity: string | null;
  headline: string;
  refUrl: string | null;
  agentId: string | null;
  agentName: string | null;
  runId: string | null;
  meta: unknown;
  readAt: string | null;
  createdAt: string;
}

/** How many older rows one "Show more" asks for — the route's MAX_LIMIT. */
export const MORE_LIMIT = 100;

export function toCard(row: NotificationApiRow): NotificationCard {
  return {
    id: row.id,
    kind: row.kind,
    connector: row.connector,
    entity: row.entity,
    headline: row.headline,
    refUrl: row.refUrl,
    agentId: row.agentId,
    agentName: row.agentName,
    runId: row.runId,
    meta: row.meta ?? null,
    unread: row.readAt === null,
    createdAt: row.createdAt,
  };
}

const nullableString = (value: unknown): string | null => (isString(value) ? value : null);

/**
 * The rows a "Show more" answer carries, as cards. A row missing its id,
 * kind, headline or timestamp is dropped rather than drawn half-empty.
 */
export function parseMorePage(body: unknown): NotificationCard[] {
  const list = isRecord(body) && Array.isArray(body.notifications) ? body.notifications : [];
  return list.flatMap((row: unknown): NotificationCard[] => {
    if (!isRecord(row)) return [];
    const { id, kind, headline, createdAt } = row;
    if (!isString(id) || !isString(kind) || !isString(headline) || !isString(createdAt)) return [];
    return [
      toCard({
        id,
        kind,
        headline,
        createdAt,
        connector: nullableString(row.connector),
        entity: nullableString(row.entity),
        refUrl: nullableString(row.refUrl),
        agentId: nullableString(row.agentId),
        agentName: nullableString(row.agentName),
        runId: nullableString(row.runId),
        meta: row.meta,
        readAt: nullableString(row.readAt),
      }),
    ];
  });
}

export interface FeedState {
  /** "Show more" pages, appended after `rows`; only ever grow. */
  extraRows: NotificationCard[];
  hasMore: boolean;
  loadingMore: boolean;
  /** Deleted this visit — hidden at once, gone for real on the next refresh. */
  removed: ReadonlySet<string>;
  selected: ReadonlySet<string>;
  /** The row whose ⋯ menu is open; one at a time. */
  menuFor: string | null;
  /** The ids the delete confirmation is asking about; null when it is closed. */
  confirming: string[] | null;
  deleting: boolean;
  markingAll: boolean;
  /**
   * "Mark all as read" answered: sits between the real unread count and
   * "0 unread now", so a still-loading server refresh doesn't flash the
   * button back.
   */
  allMarkedRead: boolean;
  /** Read state changed this visit — id → is now read. */
  readOverride: ReadonlyMap<string, boolean>;
}

export type FeedAction =
  | { type: 'toggle'; id: string }
  | { type: 'selectAll'; ids: string[] }
  | { type: 'selectNone' }
  | { type: 'menuToggled'; id: string }
  | { type: 'menuClosed' }
  | { type: 'deleteAsked'; ids: string[] }
  | { type: 'deleteCancelled' }
  | { type: 'deleteSent' }
  | { type: 'deleted'; ids: string[] }
  /** The delete was refused or never arrived: nothing was deleted. */
  | { type: 'deleteFailed' }
  /** Mark read or unread — optimistic: the row changes before the POST answers. */
  | { type: 'readChanged'; ids: string[]; read: boolean }
  | { type: 'markAllSent' }
  /** `ids`: every row loaded, so each one dims at once. */
  | { type: 'markedAll'; ids: string[] }
  | { type: 'markAllFailed' }
  | { type: 'moreSent' }
  | { type: 'moreLoaded'; rows: NotificationCard[] }
  /** Leaves "Show more" up, so the person can just try again. */
  | { type: 'moreFailed' };

export function initFeed(initialHasMore: boolean): FeedState {
  return {
    extraRows: [],
    hasMore: initialHasMore,
    loadingMore: false,
    removed: new Set(),
    selected: new Set(),
    menuFor: null,
    confirming: null,
    deleting: false,
    markingAll: false,
    allMarkedRead: false,
    readOverride: new Map(),
  };
}

function withRead(
  current: ReadonlyMap<string, boolean>,
  ids: string[],
  read: boolean
): ReadonlyMap<string, boolean> {
  const next = new Map(current);
  for (const id of ids) next.set(id, read);
  return next;
}

export function feedReducer(state: FeedState, action: FeedAction): FeedState {
  switch (action.type) {
    case 'toggle': {
      const selected = new Set(state.selected);
      if (selected.has(action.id)) selected.delete(action.id);
      else selected.add(action.id);
      return { ...state, selected };
    }
    case 'selectAll':
      return { ...state, selected: new Set(action.ids) };
    case 'selectNone':
      return { ...state, selected: new Set() };
    case 'menuToggled':
      return { ...state, menuFor: state.menuFor === action.id ? null : action.id };
    case 'menuClosed':
      return { ...state, menuFor: null };
    case 'deleteAsked':
      return { ...state, menuFor: null, confirming: action.ids };
    case 'deleteCancelled':
      // Not while the delete is on its way: the answer still has to land.
      return state.deleting ? state : { ...state, confirming: null };
    case 'deleteSent':
      return { ...state, deleting: true };
    case 'deleted':
      return {
        ...state,
        deleting: false,
        confirming: null,
        selected: new Set(),
        removed: new Set([...state.removed, ...action.ids]),
      };
    case 'deleteFailed':
      // The dialog stays up, the rows stay, so the person can retry.
      return { ...state, deleting: false };
    case 'readChanged':
      if (action.ids.length === 0) return state;
      return { ...state, readOverride: withRead(state.readOverride, action.ids, action.read) };
    case 'markAllSent':
      return { ...state, markingAll: true };
    case 'markedAll':
      return {
        ...state,
        markingAll: false,
        allMarkedRead: true,
        readOverride: withRead(state.readOverride, action.ids, true),
      };
    case 'markAllFailed':
      return { ...state, markingAll: false };
    case 'moreSent':
      return { ...state, loadingMore: true };
    case 'moreLoaded':
      return {
        ...state,
        loadingMore: false,
        extraRows: [...state.extraRows, ...action.rows],
        // Fewer than asked for means the table ran out, not the limit.
        hasMore: state.hasMore && action.rows.length >= MORE_LIMIT,
      };
    case 'moreFailed':
      return { ...state, loadingMore: false };
  }
}

/**
 * Every loaded row, newest first: the server page's rows, then the older
 * pages. Deduped by id — a refresh can shift `rows`' window enough to
 * overlap the oldest page at the edges, and `rows` (always the current
 * truth) wins.
 */
export function allRows(state: FeedState, rows: NotificationCard[]): NotificationCard[] {
  const seen = new Set(rows.map((row) => row.id));
  return [...rows, ...state.extraRows.filter((row) => !seen.has(row.id))];
}

/** What the feed shows: every loaded row but the ones deleted this visit. */
export function visibleRows(state: FeedState, rows: NotificationCard[]): NotificationCard[] {
  return allRows(state, rows).filter((row) => !state.removed.has(row.id));
}

export function isUnread(state: FeedState, row: NotificationCard): boolean {
  const override = state.readOverride.get(row.id);
  return override === undefined ? row.unread : !override;
}

/** The first selected row turns on checkboxes and the footer. */
export function selectionMode(state: FeedState): boolean {
  return state.selected.size > 0;
}

/** The footer's toggle reads "Select none" once every shown row is selected. */
export function allSelected(state: FeedState, rows: NotificationCard[]): boolean {
  return selectionMode(state) && state.selected.size === visibleRows(state, rows).length;
}

/**
 * The "N unread" line beside "Mark all as read", or null when there is
 * nothing to mark (or the selection footer has the floor). `unreadCount`
 * is the server's TRUE total, which can be more than are loaded.
 */
export function markAllBanner(
  state: FeedState,
  rows: NotificationCard[],
  unreadCount: number
): string | null {
  if (state.allMarkedRead || unreadCount <= 0 || selectionMode(state)) return null;
  const shown = visibleRows(state, rows).length;
  return `${unreadCount} unread${unreadCount > shown ? ' (some not shown below)' : ''}`;
}

/** The floating "Show more" pill: more to load, scrolled to the end, no selection footer. */
export function showMoreVisible(state: FeedState, nearBottom: boolean): boolean {
  return state.hasMore && nearBottom && !selectionMode(state);
}

/** The delete confirmation's words for this many notifications. */
export function confirmWording(count: number): { title: string; body: string } {
  return count === 1
    ? { title: 'Delete this notification?', body: 'It disappears' }
    : { title: `Delete ${count} notifications?`, body: 'They disappear' };
}

/** What Mark as read / Mark as unread POSTs to /api/notifications. */
export function readRequest(ids: string[], read: boolean): { ids: string[]; unread?: true } {
  return read ? { ids } : { ids, unread: true };
}

/**
 * "Mark all as read" POSTs one `{ all: true }`, reaching rows past the
 * page that never loaded — not one id per row.
 */
export const MARK_ALL_REQUEST = { all: true } as const;

/** What a delete sends (DELETE /api/notifications). */
export function deleteRequest(ids: string[]): { ids: string[] } {
  return { ids };
}

/**
 * The query "Show more" sends: one page further back than the oldest row
 * loaded, cursored on its own timestamp so no row is skipped or repeated.
 * Null when there is nothing to ask: already loading, nothing more, or no
 * row to cursor on.
 */
export function moreQuery(
  state: FeedState,
  rows: NotificationCard[]
): { before: string; limit: string } | null {
  if (state.loadingMore || !state.hasMore) return null;
  const loaded = allRows(state, rows);
  const oldest = loaded[loaded.length - 1];
  if (!oldest) return null;
  return { before: oldest.createdAt, limit: String(MORE_LIMIT) };
}

/**
 * What a click on a row does: in selection mode, or with shift/cmd/ctrl
 * held, it selects; otherwise it opens the link (and marks the row read).
 */
export function rowClick(
  state: FeedState,
  modifiers: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }
): 'select' | 'open' {
  return selectionMode(state) || modifiers.shiftKey || modifiers.metaKey || modifiers.ctrlKey
    ? 'select'
    : 'open';
}

/**
 * A `refUrl` on this origin (a chat, a permission ask) opens in this tab,
 * like every other in-app link; the provider's own link opens in a new one.
 */
export function refLinkAttrs(refUrl: string): { target?: string; rel?: string } {
  return refUrl.startsWith('/') && !refUrl.startsWith('//')
    ? {}
    : { target: '_blank', rel: 'noopener noreferrer' };
}

/** Where one row's links go, and what its menu calls them. */
export interface RowLinks {
  /** The menu's label for `refUrl`. */
  openLabel: string;
  /** The run the row belongs to, when it names one. */
  runHref: string | null;
  /** The in-app thing the row is about: an agent, or a batch's own page. */
  agentHref: string | null;
  /** The menu's label for `agentHref`. */
  inAppLabel: string;
  /**
   * What the headline (stretched over the whole row) opens when there is
   * no `refUrl`: `agentHref`, else the run — a row with neither a link nor
   * an agent still belongs to a run, and must not be unopenable.
   */
  primaryInAppHref: string | null;
  /** The run is already the headline's link, so the menu has no "Show run". */
  runIsPrimary: boolean;
  batch: BatchNotificationMeta | null;
  /** A batch row's counts ("3 of 10 done"); '' otherwise. */
  batchProgress: string;
}

export function rowLinks(row: NotificationCard): RowLinks {
  const openLabel =
    row.kind === 'chat_reply' || row.kind === 'chat_permission'
      ? 'Open chat'
      : `Open ${row.entity ?? 'link'}`;
  const runHref = row.runId && row.agentId ? `/agents/${row.agentId}/runs/${row.runId}` : null;
  const batch = isBatchNotificationKind(row.kind) ? parseBatchNotificationMeta(row.meta) : null;
  const agentHref = batch
    ? batchNotificationHref(batch)
    : (row.kind === 'agent_edited' ||
          row.kind === 'agent_disabled' ||
          row.kind === 'agent_shared') &&
        row.agentId
      ? `/agents/${row.agentId}`
      : null;
  const runIsPrimary = !row.refUrl && !agentHref && runHref !== null;
  return {
    openLabel,
    runHref,
    agentHref,
    inAppLabel: batch ? 'Open batch' : 'Open agent',
    primaryInAppHref: agentHref ?? (runIsPrimary ? runHref : null),
    runIsPrimary,
    batch,
    batchProgress: batch ? batchNotificationProgress(batch) : '',
  };
}

/** A day heading a person recognises without doing arithmetic. */
export function dayLabel(when: Date, today: Date): string {
  const day = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diff = Math.round((day(today).getTime() - day(when).getTime()) / 86_400_000);
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return when.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

/** The rows under day headings, in one pass, order kept — the rows arrive newest first. */
export function groupByDay(
  rows: NotificationCard[],
  now: Date
): { label: string; rows: NotificationCard[] }[] {
  const days: { label: string; rows: NotificationCard[] }[] = [];
  for (const row of rows) {
    const label = dayLabel(new Date(row.createdAt), now);
    const last = days[days.length - 1];
    if (last && last.label === label) last.rows.push(row);
    else days.push({ label, rows: [row] });
  }
  return days;
}
