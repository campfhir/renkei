/**
 * The global keyboard shortcuts (global-shortcuts.model.ts), as a person
 * pressing them would describe it. The key caps per OS and the chord and
 * sequence matching themselves are lib/shortcuts.test.ts's. The browser
 * spec (global-shortcuts.spec.ts) keeps what only a browser shows: a real
 * key reaching the page and the right dialog or page coming up, focus in
 * the quick chat's box, the quick chat's first turn reaching the server,
 * the phone fit, and the coach marks.
 */

import type { ChatListItem } from '@/lib/chat/views';
import { formatShortcut, shortcutKeys, type Platform } from '@/lib/shortcuts';
import {
  SWITCHER_LIMIT,
  activeChat,
  chatHref,
  chatIcon,
  chatIdOf,
  defaultModelId,
  initQuickChat,
  initialShortcuts,
  noModels,
  openSwitcher,
  quickChatReducer,
  quickChatTurn,
  quickChatView,
  recentChats,
  routeKey,
  shortcutsReducer,
  switcherKey,
  type KeyContext,
  type KeyPress,
  type QuickChatAction,
  type QuickChatSetup,
  type QuickChatState,
  type ShortcutsAction,
  type ShortcutsState,
} from './global-shortcuts.model';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function chat(n: number, over: Partial<ChatListItem> = {}): ChatListItem {
  return {
    id: id(n),
    title: `Chat ${n}`,
    projectId: null,
    projectName: null,
    projectKind: null,
    projectBranch: null,
    updatedAt: `2026-10-${String(n).padStart(2, '0')}T09:00:00.000Z`,
    lastMessageAt: `2026-10-${String(n).padStart(2, '0')}T10:00:00.000Z`,
    archived: false,
    temporary: false,
    ownerSubject: 'me',
    ownerName: null,
    via: 'owner',
    ...over,
  };
}

const press = (over: Partial<KeyPress>): KeyPress => ({
  key: '',
  code: '',
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  repeat: false,
  isComposing: false,
  defaultPrevented: false,
  typing: false,
  dialogOpen: false,
  ...over,
});

const context = (over: Partial<KeyContext> = {}): KeyContext => ({
  platform: 'other',
  isOperator: false,
  pathname: '/agents',
  typed: [],
  ...over,
});

const bareC = press({ key: 'c', code: 'KeyC' });
const ctrlJ = press({ key: 'j', code: 'KeyJ', ctrlKey: true });
const metaJ = press({ key: 'j', code: 'KeyJ', metaKey: true });

const run = (actions: ShortcutsAction[], from: ShortcutsState = initialShortcuts) =>
  actions.reduce(shortcutsReducer, from);

describe('the key caps', () => {
  it('say ⌘ on a Mac and Ctrl elsewhere, for the search and the switcher', () => {
    expect(formatShortcut('search', 'mac')).toBe('⌘ K');
    expect(formatShortcut('search', 'other')).toBe('Ctrl K');
    expect(shortcutKeys('switch-chat', 'mac')).toEqual(['⌘', 'J']);
    expect(shortcutKeys('switch-chat', 'other')).toEqual(['Ctrl', 'J']);
  });

  it('write the page chords with Option on a Mac and Alt elsewhere', () => {
    expect(formatShortcut('home', 'mac')).toBe('⌥ H');
    expect(formatShortcut('preferences', 'mac')).toBe('⌥ ,');
    expect(formatShortcut('home', 'other')).toBe('Alt H');
  });
});

describe('what a key means', () => {
  it('opens the switcher with Ctrl J off a Mac, and with ⌘ J on one', () => {
    expect(routeKey(ctrlJ, context())).toEqual({ kind: 'switch-chat', back: false });
    expect(routeKey(metaJ, context({ platform: 'mac' }))).toEqual({
      kind: 'switch-chat',
      back: false,
    });
  });

  it('does not take Control J as the switcher on a Mac', () => {
    expect(routeKey(ctrlJ, context({ platform: 'mac' }))).toEqual({ kind: 'ignore' });
  });

  it('walks the switcher backwards with Shift', () => {
    expect(routeKey({ ...ctrlJ, shiftKey: true }, context())).toEqual({
      kind: 'switch-chat',
      back: true,
    });
  });

  it('takes the chords from inside a text field and over a dialog', () => {
    expect(routeKey({ ...ctrlJ, typing: true, dialogOpen: true }, context()).kind).toBe(
      'switch-chat'
    );
    const altP = press({ key: 'p', code: 'KeyP', altKey: true, typing: true });
    expect(routeKey(altP, context())).toEqual({ kind: 'go', href: '/chat/projects' });
  });

  it.each<[string, Partial<KeyPress>, string]>([
    ['Alt P', { code: 'KeyP', altKey: true }, '/chat/projects'],
    ['Alt A', { code: 'KeyA', altKey: true }, '/chat/artifacts'],
    ['Alt Shift 1', { code: 'Digit1', altKey: true, shiftKey: true }, '/notifications'],
    ['Alt ,', { code: 'Comma', altKey: true }, '/preferences'],
    ['Ctrl Shift /', { code: 'Slash', ctrlKey: true, shiftKey: true }, '/tutorials'],
    ['Ctrl `', { code: 'Backquote', ctrlKey: true }, '/code'],
    ['Alt H', { code: 'KeyH', altKey: true }, '/'],
  ])('goes to a page with %s on Windows and Linux', (_name, keys, href) => {
    expect(routeKey(press(keys), context())).toEqual({ kind: 'go', href });
  });

  it('goes Home with Option H on a Mac', () => {
    const optionH = press({ key: '˙', code: 'KeyH', altKey: true });
    expect(routeKey(optionH, context({ platform: 'mac' }))).toEqual({ kind: 'go', href: '/' });
  });

  it('sends an operator to the Organization with Ctrl Alt Shift ,, and leaves the keys free for anyone else', () => {
    const keys = press({ code: 'Comma', ctrlKey: true, altKey: true, shiftKey: true });
    expect(routeKey(keys, context({ isOperator: true }))).toEqual({ kind: 'go', href: '/admin' });
    expect(routeKey(keys, context({ isOperator: false }))).toEqual({ kind: 'ignore' });
  });

  it('takes a page chord but goes nowhere when the person is already on that page', () => {
    const altH = press({ code: 'KeyH', altKey: true });
    expect(routeKey(altH, context({ pathname: '/' }))).toEqual({ kind: 'go', href: null });
  });

  it('starts a new chat with a bare c on the page itself', () => {
    expect(routeKey(bareC, context())).toEqual({
      kind: 'sequence',
      step: { kind: 'fire', id: 'new-chat' },
    });
  });

  it('lets a capital C start one too, as long as Shift is not held for it', () => {
    expect(routeKey(press({ key: 'C', code: 'KeyC' }), context()).kind).toBe('sequence');
  });

  it('leaves c alone in a text field: there it is just a letter', () => {
    expect(routeKey({ ...bareC, typing: true }, context())).toEqual({ kind: 'ignore' });
  });

  it('does nothing with c over a dialog, and forgets what was typed', () => {
    expect(routeKey({ ...bareC, dialogOpen: true }, context({ typed: ['x'] }))).toEqual({
      kind: 'reset',
    });
  });

  it.each<[string, Partial<KeyPress>]>([
    ['Alt', { altKey: true }],
    ['Ctrl', { ctrlKey: true }],
    ['⌘', { metaKey: true }],
    ['Shift', { shiftKey: true }],
  ])('does not take c held with %s as the shortcut', (_name, mods) => {
    expect(routeKey({ ...bareC, ...mods }, context())).toEqual({ kind: 'ignore' });
  });

  it('ignores a held key repeating, a key mid-composition, and a key already taken', () => {
    expect(routeKey({ ...bareC, repeat: true }, context()).kind).toBe('ignore');
    expect(routeKey({ ...bareC, isComposing: true }, context()).kind).toBe('ignore');
    expect(routeKey({ ...bareC, defaultPrevented: true }, context()).kind).toBe('ignore');
  });

  it('ignores named keys such as Tab and the arrows', () => {
    expect(routeKey(press({ key: 'Tab', code: 'Tab' }), context()).kind).toBe('ignore');
    expect(routeKey(press({ key: 'ArrowDown', code: 'ArrowDown' }), context()).kind).toBe('ignore');
  });

  it('forgets the keys typed so far on Escape', () => {
    expect(routeKey(press({ key: 'Escape', code: 'Escape' }), context({ typed: ['c'] }))).toEqual({
      kind: 'reset',
    });
  });

  it('a stray letter leads nowhere', () => {
    expect(routeKey(press({ key: 'x', code: 'KeyX' }), context())).toEqual({
      kind: 'sequence',
      step: { kind: 'none' },
    });
  });
});

describe('the recent-chats switcher', () => {
  const [oldest, middle, newest] = [chat(1), chat(2), chat(3)];
  const all = [oldest, newest, middle];

  it('lists the most recently talked-in chat first', () => {
    expect(recentChats(all).map((c) => c.title)).toEqual(['Chat 3', 'Chat 2', 'Chat 1']);
  });

  it('places a chat nobody spoke in by when it was last touched', () => {
    const quiet = chat(9, { lastMessageAt: null, updatedAt: '2026-10-02T12:00:00.000Z' });
    expect(recentChats([...all, quiet]).map((c) => c.title)).toEqual([
      'Chat 3',
      'Chat 9',
      'Chat 2',
      'Chat 1',
    ]);
  });

  it('leaves archived chats out', () => {
    expect(recentChats([...all, chat(4, { archived: true })]).map((c) => c.title)).not.toContain(
      'Chat 4'
    );
  });

  it(`lists at most ${SWITCHER_LIMIT}`, () => {
    const many = Array.from({ length: 15 }, (_, i) => chat(i + 1));
    const listed = recentChats(many);
    expect(listed).toHaveLength(SWITCHER_LIMIT);
    expect(listed[0].title).toBe('Chat 15');
  });

  it('opens on the chat before this one when the page is a chat', () => {
    const state = run([
      { type: 'switch-chat', back: false, chats: all, pathname: `/chat/${newest.id}` },
    ]);
    expect(state.switcher?.currentChatId).toBe(newest.id);
    expect(activeChat(state.switcher!)?.title).toBe('Chat 2');
  });

  it('opens on the most recent chat from a page that is not a chat', () => {
    const state = run([{ type: 'switch-chat', back: false, chats: all, pathname: '/agents' }]);
    expect(state.switcher?.currentChatId).toBeNull();
    expect(activeChat(state.switcher!)?.title).toBe('Chat 3');
  });

  it('opens on the most recent chat from an older chat', () => {
    const state = openSwitcher(all, `/chat/${oldest.id}/files`);
    expect(state.currentChatId).toBe(oldest.id);
    expect(activeChat(state)?.title).toBe('Chat 3');
  });

  it('pressing the chord again moves on, and Shift goes back', () => {
    const open = { type: 'switch-chat', chats: all, pathname: `/chat/${newest.id}` } as const;
    const again = run([
      { ...open, back: false },
      { ...open, back: false },
    ]);
    expect(activeChat(again.switcher!)?.title).toBe('Chat 1');
    const back = run([{ ...open, back: true }], again);
    expect(activeChat(back.switcher!)?.title).toBe('Chat 2');
  });

  it('the arrows walk the list and wrap around at either end', () => {
    const open = run([{ type: 'switch-chat', back: false, chats: all, pathname: '/agents' }]);
    const up = run([{ type: 'switcher-move', delta: -1 }], open);
    expect(activeChat(up.switcher!)?.title).toBe('Chat 1');
    const down = run([{ type: 'switcher-move', delta: 1 }], up);
    expect(activeChat(down.switcher!)?.title).toBe('Chat 3');
  });

  it('pointing at a chat picks it', () => {
    const state = run([
      { type: 'switch-chat', back: false, chats: all, pathname: '/agents' },
      { type: 'switcher-hover', index: 2 },
    ]);
    expect(activeChat(state.switcher!)?.title).toBe('Chat 1');
  });

  it('reads the arrows and Enter, and nothing else', () => {
    expect(switcherKey('ArrowDown')).toEqual({ kind: 'move', delta: 1 });
    expect(switcherKey('ArrowUp')).toEqual({ kind: 'move', delta: -1 });
    expect(switcherKey('Enter')).toEqual({ kind: 'open' });
    expect(switcherKey('c')).toBeNull();
  });

  it('Enter opens the chat picked, and nothing when it is the one already open', () => {
    const state = openSwitcher(all, `/chat/${newest.id}`);
    expect(chatHref(state, activeChat(state)!)).toBe(`/chat/${middle.id}`);
    expect(chatHref(state, newest)).toBeNull();
  });

  it('with no chats there is nothing to pick, and the arrows do not break it', () => {
    const state = run([
      { type: 'switch-chat', back: false, chats: [], pathname: '/agents' },
      { type: 'switcher-move', delta: 1 },
      { type: 'switch-chat', back: true, chats: [], pathname: '/agents' },
    ]);
    expect(state.switcher?.items).toEqual([]);
    expect(activeChat(state.switcher!)).toBeNull();
  });

  it('fills in from the whole history behind the menu, keeping the place', () => {
    const state = run([
      { type: 'switch-chat', back: false, chats: [newest], pathname: '/agents' },
      { type: 'switcher-loaded', chats: [oldest, middle, newest, chat(4)] },
    ]);
    expect(state.switcher?.items.map((c) => c.title)).toEqual([
      'Chat 4',
      'Chat 3',
      'Chat 2',
      'Chat 1',
    ]);
    expect(state.switcher?.active).toBe(0);
  });

  it('keeps the pick inside a list that came back shorter', () => {
    const state = run([
      { type: 'switch-chat', back: false, chats: all, pathname: '/agents' },
      { type: 'switcher-move', delta: -1 },
      { type: 'switcher-loaded', chats: [newest] },
    ]);
    expect(activeChat(state.switcher!)?.title).toBe('Chat 3');
  });

  it('a late history answer does not reopen a switcher that was closed', () => {
    const state = run([
      { type: 'switch-chat', back: false, chats: all, pathname: '/agents' },
      { type: 'switcher-close' },
      { type: 'switcher-loaded', chats: all },
    ]);
    expect(state.switcher).toBeNull();
  });

  it('marks a chat by what it sits in', () => {
    expect(chatIcon(chat(1, { projectKind: 'code', projectId: 'p' }))).toBe('code');
    expect(chatIcon(chat(1, { projectKind: 'chat', projectId: 'p' }))).toBe('pages');
    expect(chatIcon(chat(1))).toBe('chat');
  });

  it('reads the chat from its address, and nothing from other pages', () => {
    expect(chatIdOf(`/chat/${id(7)}`)).toBe(id(7));
    expect(chatIdOf(`/chat/${id(7)}/files`)).toBe(id(7));
    expect(chatIdOf('/chat/projects')).toBeNull();
    expect(chatIdOf('/agents')).toBeNull();
  });
});

describe('the two boxes together', () => {
  it('c opens the quick chat and closes the switcher', () => {
    const state = run([
      { type: 'switch-chat', back: false, chats: [], pathname: '/agents' },
      { type: 'new-chat' },
    ]);
    expect(state).toEqual({ quickOpen: true, switcher: null });
  });

  it('the switcher chord closes the quick chat', () => {
    const state = run([
      { type: 'new-chat' },
      { type: 'switch-chat', back: false, chats: [], pathname: '/agents' },
    ]);
    expect(state.quickOpen).toBe(false);
    expect(state.switcher).not.toBeNull();
  });

  it('going anywhere closes both', () => {
    expect(run([{ type: 'new-chat' }, { type: 'navigated' }])).toEqual(initialShortcuts);
    const switching = run([
      { type: 'switch-chat', back: false, chats: [], pathname: '/agents' },
      { type: 'navigated' },
    ]);
    expect(switching).toEqual(initialShortcuts);
  });

  it('Escape on the quick chat closes only it', () => {
    expect(run([{ type: 'new-chat' }, { type: 'quick-close' }]).quickOpen).toBe(false);
  });
});

describe('quick chat', () => {
  const setup = (models: QuickChatSetup['models']): QuickChatSetup => ({ models });
  const fold = (actions: QuickChatAction[]): QuickChatState =>
    actions.reduce(quickChatReducer, initQuickChat());

  it('says it is getting ready until the chat and the composer are both there', () => {
    expect(quickChatView(initQuickChat())).toBe('loading');
    const ready = fold([
      { type: 'ready', chatId: 'c1', setup: setup([{ id: 'm', isDefault: true }]) },
    ]);
    expect(quickChatView(ready)).toBe('composer');
  });

  it("starts on the organization's default model", () => {
    const models = [
      { id: 'a', isDefault: false },
      { id: 'b', isDefault: true },
    ];
    expect(fold([{ type: 'ready', chatId: 'c1', setup: setup(models) }]).modelId).toBe('b');
  });

  it('starts on the first model when none is the default, and on none with an empty roster', () => {
    expect(
      defaultModelId([
        { id: 'a', isDefault: false },
        { id: 'b', isDefault: false },
      ])
    ).toBe('a');
    expect(defaultModelId([])).toBeNull();
  });

  it('with no model configured, the composer is off and the box says why', () => {
    const state = fold([{ type: 'ready', chatId: 'c1', setup: setup([]) }]);
    expect(noModels(state)).toBe(true);
    expect(noModels(initQuickChat())).toBe(false);
  });

  it('a chat that could not be made shows the reason and no composer', () => {
    const state = fold([{ type: 'failed', stage: 'create', error: null }]);
    expect(state.error).toBe('Could not start a chat');
    expect(quickChatView(state)).toBe('error');
    expect(fold([{ type: 'failed', stage: 'create', error: 'Quota reached' }]).error).toBe(
      'Quota reached'
    );
  });

  it('a composer that could not load says so', () => {
    expect(fold([{ type: 'failed', stage: 'setup', error: null }]).error).toBe(
      'Could not load the composer'
    );
  });

  it('sends the text, the attached files and the model picked', () => {
    const state = fold([
      {
        type: 'ready',
        chatId: 'c1',
        setup: setup([
          { id: 'm1', isDefault: true },
          { id: 'm2', isDefault: false },
        ]),
      },
      { type: 'model', id: 'm2' },
    ]);
    expect(
      quickChatTurn(state, {
        text: 'Summarise my week\nin three bullets',
        attachments: [{ id: 'f1' }, { id: 'f2' }],
      })
    ).toEqual({
      text: 'Summarise my week\nin three bullets',
      attachmentIds: ['f1', 'f2'],
      llmModelId: 'm2',
    });
  });

  it('a refused send keeps the box open with the reason; sending again clears it', () => {
    const ready = fold([
      { type: 'ready', chatId: 'c1', setup: setup([{ id: 'm', isDefault: true }]) },
    ]);
    const refused = [
      { type: 'sending' } as const,
      { type: 'send-failed', error: 'Too long' } as const,
    ].reduce(quickChatReducer, ready);
    expect(refused.error).toBe('Too long');
    expect(quickChatView(refused)).toBe('composer');
    expect(quickChatReducer(refused, { type: 'sending' }).error).toBeNull();
  });

  it('remembers whether thinking is on', () => {
    expect(fold([{ type: 'thinking', on: true }]).thinking).toBe(true);
  });
});

// Every platform the key caps are drawn for is one the routing understands.
it.each<Platform>(['mac', 'other'])(
  'the search chord is not a global shortcut on %s',
  (platform) => {
    const k = press({ code: 'KeyK', [platform === 'mac' ? 'metaKey' : 'ctrlKey']: true });
    expect(routeKey(k, context({ platform }))).toEqual({ kind: 'ignore' });
  }
);
