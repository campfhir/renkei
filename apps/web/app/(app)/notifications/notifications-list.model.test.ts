/**
 * The notifications page's feed, as a person uses it: what they see, what
 * a press changes, and what each press sends. These were
 * notifications.spec.ts's and chat-notifications.spec.ts's rules (the
 * unread count, mark read and unread, mark all past the page, "Show more",
 * select and delete, the row menu's links); the specs keep only what a
 * browser shows.
 */

import {
  MARK_ALL_REQUEST,
  MORE_LIMIT,
  allRows,
  allSelected,
  confirmWording,
  dayLabel,
  deleteRequest,
  feedReducer,
  groupByDay,
  initFeed,
  isUnread,
  markAllBanner,
  moreQuery,
  parseMorePage,
  readRequest,
  refLinkAttrs,
  rowClick,
  rowLinks,
  selectionMode,
  showMoreVisible,
  visibleRows,
  type FeedAction,
  type FeedState,
  type NotificationCard,
} from './notifications-list.model';

function card(id: string, overrides: Partial<NotificationCard> = {}): NotificationCard {
  return {
    id,
    kind: 'agent_shared',
    connector: null,
    entity: null,
    headline: `Sam shared the agent "${id}" with you`,
    refUrl: null,
    agentId: `agent-${id}`,
    agentName: null,
    runId: null,
    meta: null,
    unread: true,
    createdAt: '2026-10-30T12:00:00.000Z',
    ...overrides,
  };
}

const run = (actions: FeedAction[], state: FeedState = initFeed(false)): FeedState =>
  actions.reduce(feedReducer, state);

const NO_KEYS = { shiftKey: false, metaKey: false, ctrlKey: false };

/** A run of rows, newest first, one minute apart. */
function page(count: number, from = 0): NotificationCard[] {
  return Array.from({ length: count }, (_, index) =>
    card(`n${from + index}`, {
      createdAt: new Date(Date.UTC(2026, 9, 30, 12, 0) - (from + index) * 60_000).toISOString(),
    })
  );
}

describe('the unread count and "Mark all as read"', () => {
  const rows = [card('a'), card('b'), card('c', { unread: false })];

  it('shows the server’s unread total beside the button', () => {
    expect(markAllBanner(initFeed(false), rows, 2)).toBe('2 unread');
  });

  it('says some are not shown when there are more unread than rows loaded', () => {
    expect(markAllBanner(initFeed(true), page(100), 105)).toBe('105 unread (some not shown below)');
  });

  it('is gone when nothing is unread', () => {
    expect(markAllBanner(initFeed(false), rows, 0)).toBeNull();
  });

  it('sends one { all: true }, not one id per row, so it reaches rows past the page', () => {
    expect(MARK_ALL_REQUEST).toEqual({ all: true });
  });

  it('once answered, every loaded row reads as read and the button stays gone while the page refreshes', () => {
    const state = run([{ type: 'markAllSent' }, { type: 'markedAll', ids: ['a', 'b', 'c'] }]);
    expect(rows.map((row) => isUnread(state, row))).toEqual([false, false, false]);
    expect(state.markingAll).toBe(false);
    // The server's count has not caught up yet: the button must not flash back.
    expect(markAllBanner(state, rows, 2)).toBeNull();
  });

  it('says "Marking…" while the request is out', () => {
    expect(run([{ type: 'markAllSent' }]).markingAll).toBe(true);
  });

  it('a refused mark-all leaves every row unread and the button up to try again', () => {
    const state = run([{ type: 'markAllSent' }, { type: 'markAllFailed' }]);
    expect(isUnread(state, rows[0])).toBe(true);
    expect(markAllBanner(state, rows, 2)).toBe('2 unread');
    expect(state.markingAll).toBe(false);
  });

  it('steps aside while rows are selected (the footer has its own Mark as read)', () => {
    const state = run([{ type: 'toggle', id: 'a' }]);
    expect(markAllBanner(state, rows, 2)).toBeNull();
  });
});

describe('marking one row read or unread', () => {
  const unreadRow = card('a');
  const readRow = card('b', { unread: false });

  it('marking unread brightens the row at once, before the server answers', () => {
    const state = run([{ type: 'readChanged', ids: ['b'], read: false }]);
    expect(isUnread(state, readRow)).toBe(true);
  });

  it('marking read dims it at once', () => {
    const state = run([{ type: 'readChanged', ids: ['a'], read: true }]);
    expect(isUnread(state, unreadRow)).toBe(false);
  });

  it('sends the ids, with unread: true only when marking unread', () => {
    expect(readRequest(['a'], true)).toEqual({ ids: ['a'] });
    expect(readRequest(['b', 'c'], false)).toEqual({ ids: ['b', 'c'], unread: true });
  });

  it('marking nothing changes nothing', () => {
    const state = initFeed(false);
    expect(feedReducer(state, { type: 'readChanged', ids: [], read: true })).toBe(state);
  });

  it('the latest press wins: read, then unread again', () => {
    const state = run([
      { type: 'markedAll', ids: ['a'] },
      { type: 'readChanged', ids: ['a'], read: false },
    ]);
    expect(isUnread(state, unreadRow)).toBe(true);
  });
});

describe('the row menu', () => {
  it('opens for one row at a time, and the same button closes it', () => {
    let state = run([{ type: 'menuToggled', id: 'a' }]);
    expect(state.menuFor).toBe('a');
    state = feedReducer(state, { type: 'menuToggled', id: 'b' });
    expect(state.menuFor).toBe('b');
    state = feedReducer(state, { type: 'menuToggled', id: 'b' });
    expect(state.menuFor).toBeNull();
  });

  it('closes on Escape or a click outside', () => {
    expect(run([{ type: 'menuToggled', id: 'a' }, { type: 'menuClosed' }]).menuFor).toBeNull();
  });

  it('a shared agent opens the agent in the app, and its menu says "Open agent"', () => {
    const links = rowLinks(card('a', { agentId: 'agent-7' }));
    expect(links.primaryInAppHref).toBe('/agents/agent-7');
    expect(links.agentHref).toBe('/agents/agent-7');
    expect(links.inAppLabel).toBe('Open agent');
  });

  it('an act with a vendor link opens it as "Open <thing>", with "Show run" beside it', () => {
    const links = rowLinks(
      card('a', {
        kind: 'act',
        entity: 'issue',
        refUrl: 'https://example.atlassian.net/browse/OPS-1',
        agentId: 'agent-7',
        runId: 'run-9',
      })
    );
    expect(links.openLabel).toBe('Open issue');
    expect(links.agentHref).toBeNull();
    expect(links.runHref).toBe('/agents/agent-7/runs/run-9');
    expect(links.runIsPrimary).toBe(false);
  });

  it('a row with no link and no agent page still opens its run, and drops "Show run"', () => {
    const links = rowLinks(card('a', { kind: 'run_failed', agentId: 'agent-7', runId: 'run-9' }));
    expect(links.primaryInAppHref).toBe('/agents/agent-7/runs/run-9');
    expect(links.runIsPrimary).toBe(true);
  });

  it('a chat reply or permission ask says "Open chat"', () => {
    expect(rowLinks(card('a', { kind: 'chat_reply', refUrl: '/chat/c1' })).openLabel).toBe(
      'Open chat'
    );
    expect(rowLinks(card('a', { kind: 'chat_permission', refUrl: '/chat/c1' })).openLabel).toBe(
      'Open chat'
    );
  });

  it('a link with no noun says "Open link"', () => {
    expect(rowLinks(card('a', { kind: 'act', refUrl: 'https://x.test' })).openLabel).toBe(
      'Open link'
    );
  });

  it('an in-app link opens in this tab, a vendor’s in a new one', () => {
    expect(refLinkAttrs('/chat/c1')).toEqual({});
    expect(refLinkAttrs('https://example.atlassian.net/browse/OPS-1')).toEqual({
      target: '_blank',
      rel: 'noopener noreferrer',
    });
    expect(refLinkAttrs('//evil.test/x')).toEqual({ target: '_blank', rel: 'noopener noreferrer' });
  });

  it('a row with nothing to open has no link', () => {
    const links = rowLinks(card('a', { kind: 'act', agentId: null }));
    expect(links.primaryInAppHref).toBeNull();
    expect(links.runHref).toBeNull();
  });
});

describe('the whole row', () => {
  it('a plain click opens it', () => {
    expect(rowClick(initFeed(false), NO_KEYS)).toBe('open');
  });

  it('shift, cmd or ctrl click selects it instead', () => {
    expect(rowClick(initFeed(false), { ...NO_KEYS, shiftKey: true })).toBe('select');
    expect(rowClick(initFeed(false), { ...NO_KEYS, metaKey: true })).toBe('select');
    expect(rowClick(initFeed(false), { ...NO_KEYS, ctrlKey: true })).toBe('select');
  });

  it('once something is selected, every click selects', () => {
    expect(rowClick(run([{ type: 'toggle', id: 'a' }]), NO_KEYS)).toBe('select');
  });
});

describe('selecting and deleting', () => {
  const rows = [card('a'), card('b'), card('c')];

  it('"Select" on a row starts selection mode with that row checked', () => {
    const state = run([{ type: 'toggle', id: 'a' }]);
    expect(selectionMode(state)).toBe(true);
    expect([...state.selected]).toEqual(['a']);
  });

  it('a second check counts two; unchecking the last ends selection mode', () => {
    let state = run([
      { type: 'toggle', id: 'a' },
      { type: 'toggle', id: 'c' },
    ]);
    expect(state.selected.size).toBe(2);
    state = run(
      [
        { type: 'toggle', id: 'a' },
        { type: 'toggle', id: 'c' },
      ],
      state
    );
    expect(selectionMode(state)).toBe(false);
  });

  it('Select all reads "Select none" once every shown row is checked', () => {
    let state = run([{ type: 'toggle', id: 'a' }]);
    expect(allSelected(state, rows)).toBe(false);
    state = feedReducer(state, { type: 'selectAll', ids: rows.map((row) => row.id) });
    expect(allSelected(state, rows)).toBe(true);
    state = feedReducer(state, { type: 'selectNone' });
    expect(selectionMode(state)).toBe(false);
  });

  it('Delete asks first, naming how many', () => {
    const state = run([
      { type: 'toggle', id: 'a' },
      { type: 'toggle', id: 'c' },
      { type: 'deleteAsked', ids: ['a', 'c'] },
    ]);
    expect(state.confirming).toEqual(['a', 'c']);
    expect(confirmWording(2)).toEqual({ title: 'Delete 2 notifications?', body: 'They disappear' });
    expect(confirmWording(1)).toEqual({
      title: 'Delete this notification?',
      body: 'It disappears',
    });
    // Nothing is gone yet.
    expect(visibleRows(state, rows)).toHaveLength(3);
  });

  it('the menu’s Delete closes the menu and asks about that one row', () => {
    const state = run([
      { type: 'menuToggled', id: 'b' },
      { type: 'deleteAsked', ids: ['b'] },
    ]);
    expect(state.menuFor).toBeNull();
    expect(state.confirming).toEqual(['b']);
  });

  it('sends the ids it asked about', () => {
    expect(deleteRequest(['a', 'c'])).toEqual({ ids: ['a', 'c'] });
  });

  it('a delete that lands hides its rows and ends selection mode', () => {
    const state = run([
      { type: 'toggle', id: 'a' },
      { type: 'toggle', id: 'c' },
      { type: 'deleteAsked', ids: ['a', 'c'] },
      { type: 'deleteSent' },
      { type: 'deleted', ids: ['a', 'c'] },
    ]);
    expect(visibleRows(state, rows).map((row) => row.id)).toEqual(['b']);
    expect(selectionMode(state)).toBe(false);
    expect(state.confirming).toBeNull();
    expect(state.deleting).toBe(false);
  });

  it('a refused delete keeps the rows, the selection and the dialog, to retry', () => {
    const state = run([
      { type: 'toggle', id: 'a' },
      { type: 'deleteAsked', ids: ['a'] },
      { type: 'deleteSent' },
      { type: 'deleteFailed' },
    ]);
    expect(visibleRows(state, rows)).toHaveLength(3);
    expect(state.confirming).toEqual(['a']);
    expect([...state.selected]).toEqual(['a']);
    expect(state.deleting).toBe(false);
  });

  it('Cancel or Escape closes the dialog, but not while the delete is on its way', () => {
    const asked = run([{ type: 'deleteAsked', ids: ['a'] }]);
    expect(feedReducer(asked, { type: 'deleteCancelled' }).confirming).toBeNull();
    const sending = feedReducer(asked, { type: 'deleteSent' });
    expect(feedReducer(sending, { type: 'deleteCancelled' }).confirming).toEqual(['a']);
  });

  it('when every row is deleted the feed is empty', () => {
    const state = run([{ type: 'deleted', ids: ['a', 'b', 'c'] }]);
    expect(visibleRows(state, rows)).toEqual([]);
  });
});

describe('"Show more"', () => {
  it('only shows with more to load, once scrolled to the end, and not over the selection footer', () => {
    expect(showMoreVisible(initFeed(true), false)).toBe(false);
    expect(showMoreVisible(initFeed(true), true)).toBe(true);
    expect(showMoreVisible(initFeed(false), true)).toBe(false);
    expect(showMoreVisible(run([{ type: 'toggle', id: 'a' }], initFeed(true)), true)).toBe(false);
  });

  it('asks for one page older than the oldest row loaded', () => {
    const rows = page(100);
    expect(moreQuery(initFeed(true), rows)).toEqual({
      before: rows[99].createdAt,
      limit: String(MORE_LIMIT),
    });
  });

  it('a second press cursors on the oldest row of the page the first one loaded', () => {
    const rows = page(100);
    const older = page(100, 100);
    const state = run([{ type: 'moreSent' }, { type: 'moreLoaded', rows: older }], initFeed(true));
    expect(moreQuery(state, rows)?.before).toBe(older[99].createdAt);
  });

  it('asks nothing while a page is loading, or when there is no more', () => {
    expect(moreQuery(run([{ type: 'moreSent' }], initFeed(true)), page(3))).toBeNull();
    expect(moreQuery(initFeed(false), page(3))).toBeNull();
  });

  it('the older rows land below the page, and a short page retires the button', () => {
    const rows = page(100);
    const state = run(
      [{ type: 'moreSent' }, { type: 'moreLoaded', rows: page(5, 100) }],
      initFeed(true)
    );
    expect(
      visibleRows(state, rows)
        .map((row) => row.id)
        .slice(-6)
    ).toEqual(['n99', 'n100', 'n101', 'n102', 'n103', 'n104']);
    expect(state.hasMore).toBe(false);
    expect(state.loadingMore).toBe(false);
  });

  it('a full page leaves the button up for another', () => {
    const state = run([{ type: 'moreLoaded', rows: page(MORE_LIMIT, 100) }], initFeed(true));
    expect(state.hasMore).toBe(true);
  });

  it('a failed page leaves the button up, to try again', () => {
    const state = run([{ type: 'moreSent' }, { type: 'moreFailed' }], initFeed(true));
    expect(state.hasMore).toBe(true);
    expect(state.loadingMore).toBe(false);
  });

  it('a refresh that slides the page over the older rows shows each row once, the fresh copy', () => {
    const state = run(
      [{ type: 'moreLoaded', rows: [card('x', { unread: true })] }],
      initFeed(true)
    );
    const refreshed = [card('x', { unread: false }), card('y')];
    const loaded = allRows(state, refreshed);
    expect(loaded.map((row) => row.id)).toEqual(['x', 'y']);
    expect(loaded[0].unread).toBe(false);
  });

  it('reads the route’s answer into cards, dropping rows it cannot draw', () => {
    const cards = parseMorePage({
      notifications: [
        {
          id: 'n1',
          kind: 'act',
          connector: 'jira',
          entity: 'issue',
          headline: 'Created OPS-1',
          refUrl: 'https://x.test',
          agentId: 'a',
          agentName: 'Triage',
          runId: 'r',
          meta: null,
          readAt: '2026-10-30T12:00:00.000Z',
          createdAt: '2026-10-30T11:00:00.000Z',
        },
        { id: 'n2', kind: 'act', headline: 'Unread one', createdAt: '2026-10-30T10:00:00.000Z' },
        { id: 7, kind: 'act' },
        'junk',
      ],
    });
    expect(cards.map((row) => [row.id, row.unread])).toEqual([
      ['n1', false],
      ['n2', true],
    ]);
    expect(cards[1].refUrl).toBeNull();
    expect(parseMorePage(null)).toEqual([]);
  });
});

describe('day headings', () => {
  const now = new Date(2026, 9, 30, 15, 0);

  it('reads Today, Yesterday, then the date', () => {
    expect(dayLabel(new Date(2026, 9, 30, 1, 0), now)).toBe('Today');
    expect(dayLabel(new Date(2026, 9, 29, 23, 0), now)).toBe('Yesterday');
    expect(dayLabel(new Date(2026, 9, 27, 9, 0), now)).not.toMatch(/Today|Yesterday/);
  });

  it('a row from the future (a fast clock) still reads Today', () => {
    expect(dayLabel(new Date(2026, 9, 31, 9, 0), now)).toBe('Today');
  });

  it('groups the rows in their order, newest first, one heading per day', () => {
    const rows = [
      card('a', { createdAt: new Date(2026, 9, 30, 14, 0).toISOString() }),
      card('b', { createdAt: new Date(2026, 9, 30, 9, 0).toISOString() }),
      card('c', { createdAt: new Date(2026, 9, 29, 9, 0).toISOString() }),
    ];
    expect(groupByDay(rows, now).map((day) => [day.label, day.rows.map((row) => row.id)])).toEqual([
      ['Today', ['a', 'b']],
      ['Yesterday', ['c']],
    ]);
  });
});
