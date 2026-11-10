import type { ChatListItem } from '@/lib/chat/views';
import {
  canLoadMore,
  chatListReducer,
  chatListView,
  dayGroup,
  initialChatListState,
  isCustomFilter,
  listedChats,
  rowActions,
  shouldRefreshOnReturn,
  stateCounts,
  type ChatListAction,
  type ChatListState,
} from './chat-nav.model';

// Local noon, so the day headings do not depend on the box's time zone.
const NOW = new Date(2026, 10, 1, 12, 0, 0);
const daysAgo = (days: number) => new Date(2026, 10, 1 - days, 10, 0, 0).toISOString();

function chat(id: string, over: Partial<ChatListItem> = {}): ChatListItem {
  return {
    id,
    title: `Chat ${id}`,
    projectId: null,
    projectName: null,
    projectKind: null,
    projectBranch: null,
    updatedAt: daysAgo(0),
    lastMessageAt: null,
    archived: false,
    temporary: false,
    ownerSubject: 'me',
    ownerName: null,
    via: 'owner',
    ...over,
  };
}

function fold(start: ChatListState, ...actions: ChatListAction[]): ChatListState {
  return actions.reduce(chatListReducer, start);
}

const fresh = (moreChatsBefore: string | null = null) => initialChatListState({ moreChatsBefore });

describe('coming back to the tab', () => {
  const visibleOnline = { visible: true, online: true };

  test('turning visible again re-reads the chat list', () => {
    expect(shouldRefreshOnReturn({ type: 'visibilitychange' }, visibleOnline)).toBe(true);
  });

  test('a page restored from the back-forward cache re-reads it', () => {
    expect(shouldRefreshOnReturn({ type: 'pageshow', persisted: true }, visibleOnline)).toBe(true);
  });

  test('an ordinary page load does not: its data is already fresh', () => {
    expect(shouldRefreshOnReturn({ type: 'pageshow', persisted: false }, visibleOnline)).toBe(
      false
    );
  });

  test('going to the background does not re-read', () => {
    expect(
      shouldRefreshOnReturn({ type: 'visibilitychange' }, { visible: false, online: true })
    ).toBe(false);
  });

  test('offline it waits; when the browser cannot say, it re-reads', () => {
    expect(
      shouldRefreshOnReturn({ type: 'visibilitychange' }, { visible: true, online: false })
    ).toBe(false);
    expect(
      shouldRefreshOnReturn({ type: 'visibilitychange' }, { visible: true, online: undefined })
    ).toBe(true);
  });
});

describe('what the list holds after a re-read', () => {
  test('a chat that finished while away shows once the server’s list has it', () => {
    const state = fresh();
    expect(chatListView(listedChats([chat('a')], state), state, NOW).groups).toEqual([
      ['Today', [chat('a')]],
    ]);
    const after = listedChats([chat('b'), chat('a')], state);
    expect(chatListView(after, state, NOW).groups[0][1].map((c) => c.id)).toEqual(['b', 'a']);
  });

  test('older chats paged in stay after a re-read, below the recent window', () => {
    const state = fold(
      fresh('c1'),
      { type: 'loadMoreStarted' },
      {
        type: 'loadMoreAnswered',
        chats: [chat('old', { updatedAt: daysAgo(40) })],
        nextBefore: null,
      }
    );
    expect(listedChats([chat('a')], state).map((c) => c.id)).toEqual(['a', 'old']);
  });

  test('a paged-in chat touched again comes back in the window, and the fresh copy wins', () => {
    const state = fold(fresh('c1'), {
      type: 'loadMoreAnswered',
      chats: [chat('old', { updatedAt: daysAgo(40), title: 'Before' })],
      nextBefore: null,
    });
    const listed = listedChats([chat('old', { title: 'Renamed' })], state);
    expect(listed).toHaveLength(1);
    expect(listed[0].title).toBe('Renamed');
  });

  test('a re-read does not rewind the cursor once Load more has moved it', () => {
    let state = fold(fresh('c1'), {
      type: 'loadMoreAnswered',
      chats: [chat('old')],
      nextBefore: 'c2',
    });
    state = chatListReducer(state, { type: 'serverCursor', moreChatsBefore: 'c1' });
    expect(state.moreBefore).toBe('c2');
  });

  test('before anything is paged in, the cursor follows the server', () => {
    const state = chatListReducer(fresh(null), { type: 'serverCursor', moreChatsBefore: 'c9' });
    expect(state.moreBefore).toBe('c9');
  });

  test('a deleted chat that only Load more had brought in leaves the list', () => {
    const state = fold(
      fresh('c1'),
      { type: 'loadMoreAnswered', chats: [chat('old'), chat('older')], nextBefore: null },
      { type: 'chatDeleted', chatId: 'old' }
    );
    expect(listedChats([], state).map((c) => c.id)).toEqual(['older']);
  });
});

describe('Load more', () => {
  test('offered while the server says there is more, and not twice at once', () => {
    expect(canLoadMore(fresh(null))).toBe(false);
    expect(canLoadMore(fresh('c1'))).toBe(true);
    expect(canLoadMore(fold(fresh('c1'), { type: 'loadMoreStarted' }))).toBe(false);
  });

  test('a failed page leaves the list and the cursor as they were', () => {
    const state = fold(fresh('c1'), { type: 'loadMoreStarted' }, { type: 'loadMoreFailed' });
    expect(state.loadingMore).toBe(false);
    expect(state.moreBefore).toBe('c1');
    expect(state.extraChats).toEqual([]);
  });
});

describe('the list as drawn', () => {
  test('my chats are grouped Today, Yesterday, This week, Earlier', () => {
    expect(dayGroup(daysAgo(0), NOW)).toBe('Today');
    expect(dayGroup(daysAgo(1), NOW)).toBe('Yesterday');
    expect(dayGroup(daysAgo(5), NOW)).toBe('This week');
    expect(dayGroup(daysAgo(30), NOW)).toBe('Earlier');
  });

  test('chats shared with me sit apart, not under a day', () => {
    const chats = [
      chat('mine'),
      chat('theirs', { via: 'grant' }),
      chat('proj', { via: 'project' }),
    ];
    const view = chatListView(chats, fresh(), NOW);
    expect(view.groups.flatMap(([, rows]) => rows.map((c) => c.id))).toEqual(['mine']);
    expect(view.shared.map((c) => c.id)).toEqual(['theirs', 'proj']);
  });

  test('archived chats show only once the funnel asks for them, and the funnel shows its dot', () => {
    const chats = [chat('a'), chat('b', { archived: true })];
    const state = fresh();
    expect(stateCounts(chats)).toEqual({ active: 1, archived: 1 });
    expect(chatListView(chats, state, NOW).groups[0][1].map((c) => c.id)).toEqual(['a']);
    expect(isCustomFilter(state.states)).toBe(false);
    const both = chatListReducer(state, {
      type: 'statesChanged',
      states: { active: true, archived: true },
    });
    expect(chatListView(chats, both, NOW).groups[0][1].map((c) => c.id)).toEqual(['a', 'b']);
    expect(isCustomFilter(both.states)).toBe(true);
  });

  test('an empty list says why', () => {
    expect(chatListView([], fresh(null), NOW).empty).toBe('Your chats will appear here.');
    expect(chatListView([], fresh('c1'), NOW).empty).toBe('No active chats.');
    const archived = [chat('a', { archived: true })];
    expect(chatListView(archived, fresh(), NOW).empty).toBe('No active chats.');
    const onlyArchived = chatListReducer(fresh(), {
      type: 'statesChanged',
      states: { active: false, archived: true },
    });
    expect(chatListView([chat('a')], onlyArchived, NOW).empty).toBe('No archived chats.');
    const none = chatListReducer(fresh(), {
      type: 'statesChanged',
      states: { active: false, archived: false },
    });
    expect(chatListView([chat('a')], none, NOW).empty).toBe(
      'Nothing to show — pick Active or Archived.'
    );
    expect(chatListView([chat('a')], fresh(), NOW).empty).toBeNull();
  });
});

describe('a row’s menu', () => {
  test('an ordinary chat can be moved into a project', () => {
    expect(rowActions(chat('a'))).toEqual(['rename', 'move', 'share', 'archive', 'delete']);
  });

  test('a code project’s chat and a temporary chat cannot', () => {
    expect(rowActions(chat('a', { projectKind: 'code' }))).not.toContain('move');
    expect(rowActions(chat('a', { temporary: true }))).toEqual([
      'rename',
      'share',
      'archive',
      'delete',
    ]);
  });
});
