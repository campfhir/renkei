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
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import Modal from '@/components/modal';
import { Icon, ICONS } from '@/components/icons';
import { chatClient } from '@/lib/chat/client';
import type { ChatSidebarData } from '@/lib/chat/sidebar';
import type { ChatListItem } from '@/lib/chat/views';
import {
  CHORD_HREFS,
  SEQUENCE_WAIT_MS,
  formatShortcut,
  isChordId,
  isTypingTarget,
  matchesShortcut,
  shortcutKeys,
  stepSequence,
  type SequenceId,
  type ShortcutId,
} from '@/lib/shortcuts';
import { usePlatform } from '@/lib/use-platform';
import { CoachAnchorContext } from '@/components/coach-marks/context';
import { getEchoCancellation, getMicrophone } from '@/lib/voice/device-settings';
import Composer, { type ComposerSubmit } from './chat/_components/composer';
import ModelSelect from './chat/_components/model-select';

const SWITCHER_LIMIT = 10;

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

/** The chat a path is on, if it is one. */
function chatIdOf(pathname: string): string | null {
  const match = /^\/chat\/([0-9a-f-]{36})(?:\/|$)/i.exec(pathname);
  return match ? match[1] : null;
}

/** Most recently talked-in first. */
function recentChats(chats: ChatListItem[]): ChatListItem[] {
  return chats
    .filter((chat) => !chat.archived)
    .sort((a, b) => (b.lastMessageAt ?? b.updatedAt).localeCompare(a.lastMessageAt ?? a.updatedAt))
    .slice(0, SWITCHER_LIMIT);
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
  const [quickOpen, setQuickOpen] = useState(false);
  const [switchOpen, setSwitchOpen] = useState(false);
  const [step, setStep] = useState<{ delta: number; at: number } | null>(null);
  const pathname = usePathname();

  // The bare keys typed so far, and the pause that settles a key which could
  // begin a longer sequence (`c`, or `c` `h`).
  const typed = useRef<string[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTyped = useCallback(() => {
    typed.current = [];
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const go = useCallback(
    (href: string) => {
      if (href !== pathname) router.push(href);
    },
    [pathname, router]
  );

  const run = useCallback((id: SequenceId) => {
    switch (id) {
      case 'new-chat':
        setSwitchOpen(false);
        setQuickOpen(true);
        break;
    }
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Chords work everywhere, a text field included.
      if (matchesShortcut('switch-chat', event, platform, true)) {
        event.preventDefault();
        clearTyped();
        setQuickOpen(false);
        if (switchOpen) setStep({ delta: event.shiftKey ? -1 : 1, at: Date.now() });
        else setSwitchOpen(true);
        return;
      }
      for (const [id, href] of Object.entries(CHORD_HREFS)) {
        if (!isChordId(id) || !matchesShortcut(id, event, platform)) continue;
        // The Organization is the operators'; for anyone else the keys are free.
        if (id === 'organization' && !isOperator) continue;
        event.preventDefault();
        clearTyped();
        go(href);
        return;
      }

      // Bare keys only count off the keyboard's business: not with a
      // modifier held, not in a field, not over a dialog (the switcher, a
      // tour, a confirmation), not as the repeat of a held key.
      if (event.key === 'Escape') return clearTyped();
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      if (event.repeat || event.isComposing || event.defaultPrevented) return;
      if (event.key.length !== 1) return;
      if (event.target instanceof HTMLElement && isTypingTarget(event.target)) return;
      if (document.querySelector('[role="dialog"]')) return clearTyped();

      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      const next = stepSequence(typed.current, event.key);
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
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [platform, switchOpen, isOperator, go, run, clearTyped]);

  useEffect(() => clearTyped, [clearTyped]);

  // Going anywhere closes both.
  useEffect(() => {
    clearTyped();
    setQuickOpen(false);
    setSwitchOpen(false);
  }, [pathname, clearTyped]);

  return (
    <>
      {quickOpen ? <QuickChat onClose={() => setQuickOpen(false)} /> : null}
      {switchOpen ? (
        <ChatSwitcher
          chats={chats}
          step={step}
          currentChatId={chatIdOf(pathname)}
          onClose={() => setSwitchOpen(false)}
        />
      ) : null}
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
function QuickChat({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [chatId, setChatId] = useState<string | null>(null);
  const [setup, setSetup] = useState<NonNullable<ComposerSetup> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modelId, setModelId] = useState<string | null>(null);
  const [thinking, setThinking] = useState(false);
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
        if (!cancelled) setError(created.error ?? 'Could not start a chat');
        return;
      }
      made = created.data.chatId;
      if (cancelled) {
        void chatClient.deleteChat(made);
        return;
      }
      if (!loaded.data) {
        setError(loaded.error ?? 'Could not load the composer');
        return;
      }
      setSetup(loaded.data);
      setModelId(
        loaded.data.models.find((m) => m.isDefault)?.id ?? loaded.data.models[0]?.id ?? null
      );
      setChatId(made);
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
    setError(null);
    const result = await chatClient.sendTurn(chatId, {
      text: input.text,
      attachmentIds: input.attachments.map((attachment) => attachment.id),
      llmModelId: modelId,
    });
    if (result.error) {
      setError(result.error);
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
          {chatId && setup ? (
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
                    setModelId(id);
                    void chatClient.updateChat(chatId, { llmModelId: id });
                  }}
                  thinking={thinking}
                  onThinking={(on) => {
                    setThinking(on);
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
          ) : error ? null : (
            <p className="px-5 pb-6 text-center text-sm text-gray-500">Getting ready…</p>
          )}
          {error ? (
            <p role="alert" className="px-5 pb-3 text-sm text-red-600 dark:text-red-400">
              {error}
            </p>
          ) : null}
          {chatId && models.length === 0 ? (
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
  chats,
  step,
  currentChatId,
  onClose,
}: {
  chats: ChatSidebarData | null;
  step: { delta: number; at: number } | null;
  currentChatId: string | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [items, setItems] = useState<ChatListItem[]>(() => recentChats(chats?.chats ?? []));
  // Opens on the chat before this one, as a switcher does.
  const [active, setActive] = useState(() => {
    const list = recentChats(chats?.chats ?? []);
    return list.length > 1 && list[0].id === currentChatId ? 1 : 0;
  });

  // The menu only carries the recent window; the full list fills in behind it.
  useEffect(() => {
    let cancelled = false;
    void chatClient.sidebar().then((result) => {
      if (!cancelled && result.data) setItems(recentChats(result.data.chats));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const move = useCallback(
    (delta: number) =>
      setActive((value) => (items.length ? (value + delta + items.length) % items.length : 0)),
    [items.length]
  );

  const lastStep = useRef<number | null>(null);
  useEffect(() => {
    if (!step || lastStep.current === step.at) return;
    lastStep.current = step.at;
    move(step.delta);
  }, [step, move]);

  const choose = (chat: ChatListItem) => {
    onClose();
    if (chat.id !== currentChatId) router.push(`/chat/${chat.id}`);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        move(1);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        move(-1);
      } else if (event.key === 'Enter' && items[active]) {
        event.preventDefault();
        choose(items[active]);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [items, active, move]);

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
                  onMouseEnter={() => setActive(index)}
                  onClick={() => choose(chat)}
                  className={`flex w-full min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm ${
                    selected ? 'bg-gray-100 dark:bg-gray-900' : ''
                  }`}
                >
                  <Icon
                    path={
                      chat.projectKind === 'code'
                        ? ICONS.code
                        : chat.projectId
                          ? ICONS.pages
                          : ICONS.chat
                    }
                    className="h-4 w-4 shrink-0 text-gray-500"
                  />
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
