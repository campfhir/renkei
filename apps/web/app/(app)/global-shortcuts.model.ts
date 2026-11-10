/**
 * What the global keyboard shortcuts decide (global-shortcuts.tsx), with no
 * DOM, timers or network:
 *
 *  - which shortcut a keydown means (`routeKey`): the recent-chats chord,
 *    a page chord (the Organization only for operators), or a bare key for
 *    the sequence machine in lib/shortcuts.ts — and when a bare key stands
 *    down (a modifier held, a repeat, typing in a field, a dialog up);
 *  - the recent-chats switcher: which chats it lists and in what order,
 *    which one it opens on, how the chord, Shift and the arrows walk it,
 *    and where Enter goes;
 *  - the quick-chat box: which model it starts on, what Send posts, what a
 *    failure leaves on screen.
 *
 * The component keeps the listeners, the pause a sequence waits out, the
 * focus, the scroll and the calls, and dispatches each outcome here. The
 * key caps per OS are lib/shortcuts.ts's. Tested in
 * global-shortcuts.model.test.ts.
 */

import {
  CHORD_HREFS,
  isChordId,
  matchesShortcut,
  stepSequence,
  type Platform,
  type SequenceStep,
} from '@/lib/shortcuts';
import type { ChatListItem, ModelOption } from '@/lib/chat/views';

/** How many chats the switcher lists. */
export const SWITCHER_LIMIT = 10;

/** The chat a path is on, if it is one. */
export function chatIdOf(pathname: string): string | null {
  const match = /^\/chat\/([0-9a-f-]{36})(?:\/|$)/i.exec(pathname);
  return match ? match[1] : null;
}

/** Most recently talked-in first (or last touched, for a chat nobody spoke in); archived left out. */
export function recentChats(chats: readonly ChatListItem[]): ChatListItem[] {
  return chats
    .filter((chat) => !chat.archived)
    .sort((a, b) => (b.lastMessageAt ?? b.updatedAt).localeCompare(a.lastMessageAt ?? a.updatedAt))
    .slice(0, SWITCHER_LIMIT);
}

/** The mark a chat is listed with: a code project's, a chat project's, or a plain chat's. */
export function chatIcon(chat: Pick<ChatListItem, 'projectKind' | 'projectId'>) {
  if (chat.projectKind === 'code') return 'code' as const;
  return chat.projectId ? ('pages' as const) : ('chat' as const);
}

// ── Keys ────────────────────────────────────────────────────────────────

/** The parts of a keydown the shortcuts read, plus what the page around it says. */
export interface KeyPress {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
  isComposing: boolean;
  /** Something earlier already took the key. */
  defaultPrevented: boolean;
  /** The key went to a field, an editor or anything that says it is a textbox. */
  typing: boolean;
  /** A dialog is up: the switcher, the quick chat, a tour, a confirmation. */
  dialogOpen: boolean;
}

export interface KeyContext {
  platform: Platform;
  isOperator: boolean;
  pathname: string;
  /** The bare keys typed so far towards a sequence. */
  typed: readonly string[];
}

/** What a keydown means to the global shortcuts. */
export type KeyRoute =
  /** Not ours: leave the key and the typed keys alone. */
  | { kind: 'ignore' }
  /** Forget the keys typed so far (Escape, or a key over a dialog). */
  | { kind: 'reset' }
  /** The recent-chats chord: open the switcher, or walk it (back with Shift). */
  | { kind: 'switch-chat'; back: boolean }
  /** A page chord; `href` is null when the person is already there. */
  | { kind: 'go'; href: string | null }
  /** A bare key towards a sequence, and what it does to the keys typed so far. */
  | { kind: 'sequence'; step: SequenceStep };

/**
 * Chords work everywhere, a text field included. Bare keys only count off
 * the keyboard's business: not with a modifier held, not as the repeat of
 * a held key or mid-composition, not in a field, not over a dialog.
 */
export function routeKey(press: KeyPress, context: KeyContext): KeyRoute {
  const { platform } = context;
  if (matchesShortcut('switch-chat', press, platform, true)) {
    return { kind: 'switch-chat', back: press.shiftKey };
  }
  for (const [id, href] of Object.entries(CHORD_HREFS)) {
    if (!isChordId(id) || !matchesShortcut(id, press, platform)) continue;
    // The Organization is the operators'; for anyone else the keys are free.
    if (id === 'organization' && !context.isOperator) continue;
    return { kind: 'go', href: href === context.pathname ? null : href };
  }

  if (press.key === 'Escape') return { kind: 'reset' };
  if (press.ctrlKey || press.metaKey || press.altKey || press.shiftKey) return { kind: 'ignore' };
  if (press.repeat || press.isComposing || press.defaultPrevented) return { kind: 'ignore' };
  if (press.key.length !== 1) return { kind: 'ignore' };
  if (press.typing) return { kind: 'ignore' };
  if (press.dialogOpen) return { kind: 'reset' };
  return { kind: 'sequence', step: stepSequence(context.typed, press.key) };
}

/** A key pressed while the switcher is up: the arrows move, Enter opens the one picked. */
export function switcherKey(
  key: string
): { kind: 'move'; delta: 1 | -1 } | { kind: 'open' } | null {
  if (key === 'ArrowDown') return { kind: 'move', delta: 1 };
  if (key === 'ArrowUp') return { kind: 'move', delta: -1 };
  if (key === 'Enter') return { kind: 'open' };
  return null;
}

// ── The two boxes ───────────────────────────────────────────────────────

export interface SwitcherState {
  items: ChatListItem[];
  active: number;
  /** The chat the page is on, marked Current and not navigated to again. */
  currentChatId: string | null;
}

export interface ShortcutsState {
  quickOpen: boolean;
  switcher: SwitcherState | null;
}

export type ShortcutsAction =
  /** The recent-chats chord, with the chats the menu carries and the page it was pressed on. */
  | { type: 'switch-chat'; back: boolean; chats: readonly ChatListItem[]; pathname: string }
  /** The whole history arrived behind the menu's recent window. */
  | { type: 'switcher-loaded'; chats: readonly ChatListItem[] }
  | { type: 'switcher-move'; delta: number }
  | { type: 'switcher-hover'; index: number }
  | { type: 'switcher-close' }
  /** `c`: the quick-chat box. */
  | { type: 'new-chat' }
  | { type: 'quick-close' }
  /** The page changed: going anywhere closes both. */
  | { type: 'navigated' };

export const initialShortcuts: ShortcutsState = { quickOpen: false, switcher: null };

/** Opens on the chat before this one, as a switcher does; elsewhere on the most recent. */
export function openSwitcher(chats: readonly ChatListItem[], pathname: string): SwitcherState {
  const items = recentChats(chats);
  const currentChatId = chatIdOf(pathname);
  return {
    items,
    active: items.length > 1 && items[0].id === currentChatId ? 1 : 0,
    currentChatId,
  };
}

function moved(switcher: SwitcherState, delta: number): SwitcherState {
  const count = switcher.items.length;
  return { ...switcher, active: count ? (switcher.active + delta + count) % count : 0 };
}

export function shortcutsReducer(state: ShortcutsState, action: ShortcutsAction): ShortcutsState {
  switch (action.type) {
    case 'switch-chat':
      return {
        quickOpen: false,
        switcher: state.switcher
          ? moved(state.switcher, action.back ? -1 : 1)
          : openSwitcher(action.chats, action.pathname),
      };
    case 'switcher-loaded': {
      if (!state.switcher) return state;
      const items = recentChats(action.chats);
      const active = Math.min(state.switcher.active, Math.max(items.length - 1, 0));
      return { ...state, switcher: { ...state.switcher, items, active } };
    }
    case 'switcher-move':
      return state.switcher ? { ...state, switcher: moved(state.switcher, action.delta) } : state;
    case 'switcher-hover':
      return state.switcher
        ? { ...state, switcher: { ...state.switcher, active: action.index } }
        : state;
    case 'switcher-close':
      return { ...state, switcher: null };
    case 'new-chat':
      return { quickOpen: true, switcher: null };
    case 'quick-close':
      return { ...state, quickOpen: false };
    case 'navigated':
      return initialShortcuts;
  }
}

/** The chat Enter opens: the one picked, if any. */
export function activeChat(switcher: SwitcherState): ChatListItem | null {
  return switcher.items[switcher.active] ?? null;
}

/** Where opening a chat goes: its thread, or nowhere when it is the one already open. */
export function chatHref(switcher: SwitcherState, chat: ChatListItem): string | null {
  return chat.id === switcher.currentChatId ? null : `/chat/${chat.id}`;
}

// ── Quick chat ──────────────────────────────────────────────────────────

/** What the composer setup carries that the quick chat decides with. */
export interface QuickChatSetup {
  models: Pick<ModelOption, 'id' | 'isDefault'>[];
}

export interface QuickChatState<S extends QuickChatSetup = QuickChatSetup> {
  /** The chat made as the box opened, once it and the composer are ready. */
  chatId: string | null;
  setup: S | null;
  error: string | null;
  modelId: string | null;
  thinking: boolean;
}

export type QuickChatAction<S extends QuickChatSetup = QuickChatSetup> =
  /** The chat was made and the composer's setup loaded. */
  | { type: 'ready'; chatId: string; setup: S }
  /** Making the chat or loading the composer failed; `error` is the server's words, if any. */
  | { type: 'failed'; stage: 'create' | 'setup'; error: string | null }
  | { type: 'sending' }
  | { type: 'send-failed'; error: string }
  | { type: 'model'; id: string }
  | { type: 'thinking'; on: boolean };

export function initQuickChat<S extends QuickChatSetup>(): QuickChatState<S> {
  return { chatId: null, setup: null, error: null, modelId: null, thinking: false };
}

/** The organization's default model, else the first on the roster, else none. */
export function defaultModelId(models: readonly Pick<ModelOption, 'id' | 'isDefault'>[]) {
  return models.find((model) => model.isDefault)?.id ?? models[0]?.id ?? null;
}

export function quickChatReducer<S extends QuickChatSetup>(
  state: QuickChatState<S>,
  action: QuickChatAction<S>
): QuickChatState<S> {
  switch (action.type) {
    case 'ready':
      return {
        ...state,
        chatId: action.chatId,
        setup: action.setup,
        modelId: defaultModelId(action.setup.models),
      };
    case 'failed':
      return {
        ...state,
        error:
          action.error ??
          (action.stage === 'create' ? 'Could not start a chat' : 'Could not load the composer'),
      };
    case 'sending':
      return { ...state, error: null };
    case 'send-failed':
      return { ...state, error: action.error };
    case 'model':
      return { ...state, modelId: action.id };
    case 'thinking':
      return { ...state, thinking: action.on };
  }
}

/** What the box shows: the composer, "Getting ready…", or only the error. */
export function quickChatView(state: QuickChatState): 'composer' | 'loading' | 'error' {
  if (state.chatId && state.setup) return 'composer';
  return state.error ? 'error' : 'loading';
}

/** Ready with nobody to send to: the composer is off and the box says why. */
export function noModels(state: QuickChatState): boolean {
  return state.chatId !== null && (state.setup?.models.length ?? 0) === 0;
}

/** What Send posts as the chat's first turn. */
export function quickChatTurn(
  state: QuickChatState,
  input: { text: string; attachments: { id: string }[] }
): { text: string; attachmentIds: string[]; llmModelId: string | null } {
  return {
    text: input.text,
    attachmentIds: input.attachments.map((attachment) => attachment.id),
    llmModelId: state.modelId,
  };
}
