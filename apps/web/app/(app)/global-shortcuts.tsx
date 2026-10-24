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

function QuickChat({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    const prompt = text.trim();
    if (!prompt || busy) return;
    setBusy(true);
    setError(null);
    const created = await chatClient.createChat({});
    if (created.error || !created.data) {
      setBusy(false);
      setError(created.error ?? 'Could not start a chat');
      return;
    }
    const chatId = created.data.chatId;
    const sent = await chatClient.sendTurn(chatId, { text: prompt, attachmentIds: [] });
    if (sent.error) {
      // The chat exists and is empty: open it with the words left to send.
      setBusy(false);
      setError(sent.error);
      return;
    }
    router.push(`/chat/${chatId}`);
  };

  return (
    <Modal title="New chat" onClose={onClose}>
      <textarea
        autoFocus
        value={text}
        rows={4}
        aria-label="Prompt"
        placeholder="Ask anything…"
        disabled={busy}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          // Enter sends; Shift+Enter is a new line; a composition in
          // progress (an IME) keeps its Enter.
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void start();
          }
        }}
        className="w-full resize-none rounded-lg border border-gray-300 bg-white p-2.5 text-base outline-none focus:border-blue-400 sm:text-sm dark:border-gray-700 dark:bg-gray-900 dark:focus:border-blue-700"
      />
      {error ? (
        <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="text-xs text-gray-500">Enter to start · Shift+Enter for a new line</p>
        <button
          type="button"
          onClick={() => void start()}
          disabled={busy || text.trim() === ''}
          className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? 'Starting…' : 'Start chat'}
        </button>
      </div>
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
