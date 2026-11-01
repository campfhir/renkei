'use client';

/**
 * The keyboard shortcuts that work from anywhere in the app (see
 * lib/shortcuts.ts for the keys and why they are these):
 *
 *  - Quick chat (`c`): a box for a prompt; Enter starts a new chat with it
 *    and goes to the thread, where the reply is already coming.
 *  - Recent chats (⌘/Ctrl J): the chats as a list, like an app switcher. It
 *    opens on the chat before this one; pressing the shortcut again (Shift
 *    to go back) or the arrow keys move, Enter opens.
 *  - Chords that go to a page: Home, Projects, Artifacts, Code, Notifications,
 *    Preferences, Tutorials and, for operators, the Organization.
 *
 * The bare key stands down in a text field and over a dialog. The search
 * (⌘/Ctrl K) lives with the search box itself.
 *
 * What a key means, the switcher's list and walk, and what the quick chat
 * sends are global-shortcuts.model.ts's; this component keeps the
 * listeners, the pause a sequence waits out, the focus and the calls.
 */

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import Modal from '@/components/modal';
import { Icon, ICONS } from '@/components/icons';
import { chatClient } from '@/lib/chat/client';
import type { ChatSidebarData } from '@/lib/chat/sidebar';
import type { ChatListItem } from '@/lib/chat/views';
import {
  SEQUENCE_WAIT_MS,
  formatShortcut,
  isTypingTarget,
  shortcutKeys,
  type SequenceId,
  type ShortcutId,
} from '@/lib/shortcuts';
import { usePlatform } from '@/lib/use-platform';
import { CoachAnchorContext } from '@/components/coach-marks/context';
import { getEchoCancellation, getMicrophone } from '@/lib/voice/device-settings';
import Composer, { type ComposerSubmit } from './chat/_components/composer';
import ModelSelect from './chat/_components/model-select';
import {
  activeChat,
  chatHref,
  chatIcon,
  initQuickChat,
  initialShortcuts,
  noModels,
  quickChatReducer,
  quickChatTurn,
  quickChatView,
  routeKey,
  shortcutsReducer,
  switcherKey,
  type ShortcutsAction,
  type SwitcherState,
} from './global-shortcuts.model';

/** A shortcut drawn as key caps. */
export function Keys({ id, className = '' }: { id: ShortcutId; className?: string }) {
  const platform = usePlatform();
  return (
    <span className={`inline-flex gap-1 ${className}`} aria-label={formatShortcut(id, platform)}>
      {shortcutKeys(id, platform).map((key) => (
        <kbd
          key={key}
          aria-hidden="true"
          className="rounded border border-gray-300 px-1 text-[11px] text-gray-500 dark:border-gray-700"
        >
          {key}
        </kbd>
      ))}
    </span>
  );
}

export function GlobalShortcuts({
  chats,
  isOperator,
}: {
  chats: ChatSidebarData | null;
  isOperator: boolean;
}) {
  const platform = usePlatform();
  const router = useRouter();
  const pathname = usePathname();
  const [state, dispatch] = useReducer(shortcutsReducer, initialShortcuts);

  // The bare keys typed so far, and the pause that settles a key which could
  // begin a longer sequence (`c`, or `c` `h`).
  const typed = useRef<string[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTyped = useCallback(() => {
    typed.current = [];
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const run = useCallback((id: SequenceId) => {
    switch (id) {
      case 'new-chat':
        dispatch({ type: 'new-chat' });
        break;
    }
  }, []);

  // The menu's recent window, as it is when the chord is pressed.
  const menuChats = chats?.chats;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const route = routeKey(
        {
          key: event.key,
          code: event.code,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
          repeat: event.repeat,
          isComposing: event.isComposing,
          defaultPrevented: event.defaultPrevented,
          typing: event.target instanceof HTMLElement && isTypingTarget(event.target),
          dialogOpen: document.querySelector('[role="dialog"]') !== null,
        },
        { platform, isOperator, pathname, typed: typed.current }
      );
      switch (route.kind) {
        case 'ignore':
          return;
        case 'reset':
          return clearTyped();
        case 'switch-chat':
          event.preventDefault();
          clearTyped();
          dispatch({ type: 'switch-chat', back: route.back, chats: menuChats ?? [], pathname });
          return;
        case 'go':
          event.preventDefault();
          clearTyped();
          if (route.href) router.push(route.href);
          return;
        case 'sequence': {
          if (timer.current) clearTimeout(timer.current);
          timer.current = null;
          const next = route.step;
          if (next.kind === 'none') {
            typed.current = [];
            return;
          }
          event.preventDefault();
          if (next.kind === 'fire') {
            clearTyped();
            run(next.id);
            return;
          }
          typed.current = next.buffer;
          timer.current = setTimeout(() => {
            clearTyped();
            if (next.fire) run(next.fire);
          }, SEQUENCE_WAIT_MS);
        }
      }
    };
    document.addEventListener('keydown', onKey);
    // Says the keys are listened for, and for which keyboard (a hydrating
    // page reads 'other' until it has asked the browser): a browser test
    // presses once, after this, rather than until a key lands.
    document.documentElement.dataset.shortcuts = platform;
    return () => {
      document.removeEventListener('keydown', onKey);
      delete document.documentElement.dataset.shortcuts;
    };
  }, [platform, isOperator, pathname, menuChats, router, run, clearTyped]);

  useEffect(() => clearTyped, [clearTyped]);

  // Going anywhere closes both.
  useEffect(() => {
    clearTyped();
    dispatch({ type: 'navigated' });
  }, [pathname, clearTyped]);

  return (
    <>
      {state.quickOpen ? <QuickChat onClose={() => dispatch({ type: 'quick-close' })} /> : null}
      {state.switcher ? <ChatSwitcher switcher={state.switcher} dispatch={dispatch} /> : null}
    </>
  );
}

type ComposerSetup = Awaited<ReturnType<typeof chatClient.composerSetup>>['data'];

/**
 * The box `c` opens: the thread's own composer on a chat made as it opens,
 * so attachments, prompts, dictation and the model picker are the ones the
 * thread has. Send starts the turn and goes to the thread. A chat nobody
 * sent anything in is deleted again as the box closes.
 */
type Setup = NonNullable<ComposerSetup>;

function QuickChat({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [state, dispatch] = useReducer(quickChatReducer<Setup>, undefined, initQuickChat<Setup>);
  const { chatId, setup, error, modelId, thinking } = state;
  const sent = useRef(false);
  const body = useRef<HTMLDivElement>(null);
  // Read once the box is open (there is no storage on the server).
  const [echoCancellation] = useState(getEchoCancellation);
  const [microphone] = useState(getMicrophone);

  useEffect(() => {
    let cancelled = false;
    let made: string | null = null;
    void (async () => {
      const [created, loaded] = await Promise.all([
        chatClient.createChat({}),
        chatClient.composerSetup(),
      ]);
      if (created.error || !created.data) {
        if (!cancelled) dispatch({ type: 'failed', stage: 'create', error: created.error ?? null });
        return;
      }
      made = created.data.chatId;
      if (cancelled) {
        void chatClient.deleteChat(made);
        return;
      }
      if (!loaded.data) {
        dispatch({ type: 'failed', stage: 'setup', error: loaded.error ?? null });
        return;
      }
      dispatch({ type: 'ready', chatId: made, setup: loaded.data });
    })();
    return () => {
      cancelled = true;
      if (made && !sent.current) void chatClient.deleteChat(made);
    };
  }, []);

  // The cursor goes straight to the box.
  useEffect(() => {
    if (chatId) body.current?.querySelector('textarea')?.focus();
  }, [chatId]);

  const submit = async (input: ComposerSubmit): Promise<boolean> => {
    if (!chatId) return false;
    dispatch({ type: 'sending' });
    const result = await chatClient.sendTurn(chatId, quickChatTurn(state, input));
    if (result.error) {
      dispatch({ type: 'send-failed', error: result.error });
      return false;
    }
    sent.current = true;
    router.push(`/chat/${chatId}`);
    return true;
  };

  const models = setup?.models ?? [];
  const voice = setup?.voice ?? null;
  return (
    <Modal title="New chat" size="lg" flush onClose={onClose}>
      {/* This composer is not the thread's: its anchors must not bring the chat tour here. */}
      <CoachAnchorContext.Provider value={null}>
        <div ref={body}>
          {quickChatView(state) === 'composer' && chatId && setup ? (
            <Composer
              chatId={chatId}
              disabled={models.length === 0}
              running={false}
              queue={[]}
              onRemoveQueued={() => {}}
              onClearQueue={() => {}}
              uploads={setup.uploadsEnabled}
              massUploadThreshold={setup.massUploadThreshold}
              onSubmit={submit}
              onCompact={async () => false}
              onStop={async () => {}}
              editing={null}
              bare
              onCancelEdit={() => {}}
              modelControl={
                <ModelSelect
                  models={models}
                  value={modelId}
                  onChange={(id) => {
                    dispatch({ type: 'model', id });
                    void chatClient.updateChat(chatId, { llmModelId: id });
                  }}
                  thinking={thinking}
                  onThinking={(on) => {
                    dispatch({ type: 'thinking', on });
                    void chatClient.updateChat(chatId, { thinkingEnabled: on });
                  }}
                  hasHistory={false}
                />
              }
              dictation={
                voice
                  ? {
                      locale: voice.prefs.locale ?? voice.defaultLocale,
                      detectLanguage: voice.prefs.detectLanguage,
                      onHeard: () => {},
                      accent: voice.prefs.userAccent,
                      echoCancellation,
                      microphone,
                    }
                  : null
              }
            />
          ) : quickChatView(state) === 'error' ? null : (
            <p className="px-5 pb-6 text-center text-sm text-gray-500">Getting ready…</p>
          )}
          {error ? (
            <p role="alert" className="px-5 pb-3 text-sm text-red-600 dark:text-red-400">
              {error}
            </p>
          ) : null}
          {noModels(state) ? (
            <p className="px-5 pb-3 text-sm text-gray-500">
              No model is configured for this organization yet. An administrator can add one under
              Agent models.
            </p>
          ) : null}
        </div>
      </CoachAnchorContext.Provider>
    </Modal>
  );
}

function ChatSwitcher({
  switcher,
  dispatch,
}: {
  switcher: SwitcherState;
  dispatch: (action: ShortcutsAction) => void;
}) {
  const router = useRouter();
  const { items, active, currentChatId } = switcher;
  const onClose = () => dispatch({ type: 'switcher-close' });

  // The menu only carries the recent window; the full list fills in behind it.
  useEffect(() => {
    let cancelled = false;
    void chatClient.sidebar().then((result) => {
      if (!cancelled && result.data)
        dispatch({ type: 'switcher-loaded', chats: result.data.chats });
    });
    return () => {
      cancelled = true;
    };
  }, [dispatch]);

  const choose = useCallback(
    (chat: ChatListItem) => {
      const href = chatHref(switcher, chat);
      dispatch({ type: 'switcher-close' });
      if (href) router.push(href);
    },
    [switcher, dispatch, router]
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const command = switcherKey(event.key);
      if (!command) return;
      if (command.kind === 'move') {
        event.preventDefault();
        dispatch({ type: 'switcher-move', delta: command.delta });
        return;
      }
      const chat = activeChat(switcher);
      if (!chat) return;
      event.preventDefault();
      choose(chat);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [switcher, choose, dispatch]);

  const activeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [active, items]);

  return (
    <Modal title="Recent chats" onClose={onClose}>
      {items.length === 0 ? (
        <p className="py-3 text-sm text-gray-500">No chats yet.</p>
      ) : (
        <ul
          role="listbox"
          aria-label="Recent chats"
          className="max-h-[60vh] space-y-0.5 overflow-y-auto"
        >
          {items.map((chat, index) => {
            const selected = index === active;
            return (
              <li key={chat.id} role="presentation">
                <button
                  ref={selected ? activeRef : undefined}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onMouseEnter={() => dispatch({ type: 'switcher-hover', index })}
                  onClick={() => choose(chat)}
                  className={`flex w-full min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm ${
                    selected ? 'bg-gray-100 dark:bg-gray-900' : ''
                  }`}
                >
                  <Icon path={ICONS[chatIcon(chat)]} className="h-4 w-4 shrink-0 text-gray-500" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{chat.title ?? 'New chat'}</span>
                    {chat.projectName ? (
                      <span className="block truncate text-xs text-gray-500">
                        {chat.projectName}
                      </span>
                    ) : null}
                  </span>
                  {chat.id === currentChatId ? (
                    <span className="shrink-0 text-xs text-gray-500">Current</span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-3 flex flex-wrap items-center gap-x-2 text-xs text-gray-500">
        <Keys id="switch-chat" /> or ↑ ↓ to move · Enter to open
      </p>
    </Modal>
  );
}
