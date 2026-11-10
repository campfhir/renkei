/**
 * The chat list in the app menu (chat-nav.tsx's ChatList) and when the
 * menu re-reads it (nav.tsx). The components make the calls, listen to
 * the browser and draw; what they decide is here, and tested in
 * chat-nav.model.test.ts:
 *
 * - coming back to the tab (it turns visible again, or the page is
 *   restored from the back-forward cache) re-reads the list, unless the
 *   browser knows it is offline;
 * - what the list holds after a re-read: the server's recent window, plus
 *   older chats "Load more" paged in, the fresh copy winning; the cursor
 *   follows the server only until something has been paged in;
 * - which chats show (the Active/Archived funnel), mine grouped by day,
 *   then the ones shared with me, and what an empty list says;
 * - which actions a row's menu offers.
 *
 * The row menu's flip and the list's scrolling are layout, measured in
 * the browser, and stay in the component.
 */

import type { ChatListItem } from '@/lib/chat/views';

/** A browser event that may mean the person came back to the tab. */
export type ReturnEvent = { type: 'visibilitychange' } | { type: 'pageshow'; persisted: boolean };

/**
 * Whether a return re-reads the chat list: the page is visible, the
 * browser does not say it is offline (an unknown is not offline), and a
 * pageshow only counts when the page came back from the back-forward
 * cache (a first load already has fresh data).
 */
export function shouldRefreshOnReturn(
  event: ReturnEvent,
  page: { visible: boolean; online: boolean | undefined }
): boolean {
  if (event.type === 'pageshow' && !event.persisted) return false;
  if (!page.visible) return false;
  return page.online !== false;
}

/** Which states the list shows. */
export interface ChatStates {
  active: boolean;
  archived: boolean;
}

export interface ChatListState {
  /** The funnel; active only to start with. */
  states: ChatStates;
  /** Older chats "Load more" paged in, beyond the server's recent window. */
  extraChats: ChatListItem[];
  /** The cursor for the next page; null when there is nothing older. */
  moreBefore: string | null;
  loadingMore: boolean;
}

export type ChatListAction =
  | { type: 'statesChanged'; states: ChatStates }
  /** The layout's data came again (a refresh); its cursor for older chats. */
  | { type: 'serverCursor'; moreChatsBefore: string | null }
  | { type: 'loadMoreStarted' }
  | { type: 'loadMoreAnswered'; chats: ChatListItem[]; nextBefore: string | null }
  | { type: 'loadMoreFailed' }
  /** A delete succeeded: a paged-in copy goes too, since no refresh can drop it. */
  | { type: 'chatDeleted'; chatId: string };

export function initialChatListState(data: { moreChatsBefore: string | null }): ChatListState {
  return {
    states: { active: true, archived: false },
    extraChats: [],
    moreBefore: data.moreChatsBefore,
    loadingMore: false,
  };
}

export function chatListReducer(state: ChatListState, action: ChatListAction): ChatListState {
  switch (action.type) {
    case 'statesChanged':
      return { ...state, states: action.states };
    case 'serverCursor':
      // Only follow the server's cursor while nothing has been paged in:
      // once "Load more" has advanced it, a refresh (the window never
      // moves) must not rewind it and re-offer rows already loaded.
      if (state.extraChats.length > 0 || state.moreBefore === action.moreChatsBefore) return state;
      return { ...state, moreBefore: action.moreChatsBefore };
    case 'loadMoreStarted':
      return { ...state, loadingMore: true };
    case 'loadMoreAnswered':
      return {
        ...state,
        loadingMore: false,
        extraChats: [...state.extraChats, ...action.chats],
        moreBefore: action.nextBefore,
      };
    case 'loadMoreFailed':
      return { ...state, loadingMore: false };
    case 'chatDeleted':
      if (!state.extraChats.some((chat) => chat.id === action.chatId)) return state;
      return { ...state, extraChats: state.extraChats.filter((chat) => chat.id !== action.chatId) };
  }
}

/** Whether "Load more" can fetch now. */
export function canLoadMore(state: ChatListState): boolean {
  return state.moreBefore !== null && !state.loadingMore;
}

/**
 * Every chat the list knows: the server's window first, then paged-in
 * ones it does not hold — a chat touched again falls back inside the
 * window, and the fresh copy wins.
 */
export function listedChats(fresh: readonly ChatListItem[], state: ChatListState): ChatListItem[] {
  const freshIds = new Set(fresh.map((chat) => chat.id));
  return [...fresh, ...state.extraChats.filter((chat) => !freshIds.has(chat.id))];
}

/** The funnel's counts. */
export function stateCounts(chats: readonly ChatListItem[]): { active: number; archived: number } {
  return {
    active: chats.filter((chat) => !chat.archived).length,
    archived: chats.filter((chat) => chat.archived).length,
  };
}

/** Whether the funnel shows its dot: anything but active only. */
export function isCustomFilter(states: ChatStates): boolean {
  return !states.active || states.archived;
}

/** The day heading a chat sits under, by its last activity, in local time. */
export function dayGroup(iso: string, now: Date): string {
  const date = new Date(iso);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 86_400_000;
  if (date.getTime() >= startOfToday) return 'Today';
  if (date.getTime() >= startOfToday - day) return 'Yesterday';
  if (date.getTime() >= startOfToday - 7 * day) return 'This week';
  return 'Earlier';
}

/** What the list draws: mine by day (in the order given), then shared with me. */
export interface ChatListView {
  groups: [string, ChatListItem[]][];
  shared: ChatListItem[];
  /** The line shown when nothing is listed; null when something is. */
  empty: string | null;
}

export function chatListView(
  chats: readonly ChatListItem[],
  state: ChatListState,
  now: Date
): ChatListView {
  const { states } = state;
  const shown = (chat: ChatListItem) => (chat.archived ? states.archived : states.active);
  const mine = chats.filter((chat) => chat.via === 'owner' && shown(chat));
  const shared = chats.filter((chat) => chat.via !== 'owner' && shown(chat));
  const groups = new Map<string, ChatListItem[]>();
  for (const chat of mine) {
    const key = dayGroup(chat.updatedAt, now);
    groups.set(key, [...(groups.get(key) ?? []), chat]);
  }
  const empty =
    groups.size > 0 || shared.length > 0
      ? null
      : chats.length === 0 && state.moreBefore === null
        ? 'Your chats will appear here.'
        : !states.active && !states.archived
          ? 'Nothing to show — pick Active or Archived.'
          : states.active
            ? 'No active chats.'
            : 'No archived chats.';
  return { groups: [...groups.entries()], shared, empty };
}

export type RowAction = 'rename' | 'move' | 'share' | 'archive' | 'delete';

/**
 * A row's menu. A chat in a code project belongs to its repository and a
 * temporary chat stands outside projects (lib/chat/temporary.ts), so
 * neither is moved into a chat project from here.
 */
export function rowActions(chat: Pick<ChatListItem, 'projectKind' | 'temporary'>): RowAction[] {
  return chat.projectKind === 'code' || chat.temporary
    ? ['rename', 'share', 'archive', 'delete']
    : ['rename', 'move', 'share', 'archive', 'delete'];
}
