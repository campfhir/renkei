'use client';

/**
 * A temporary chat (lib/chat/temporary.ts): the switch on an empty chat's
 * composer that makes it one, or stops it being one, before its first
 * message — and the ghost in its title bar from then on: hovering it says
 * what a temporary chat is, clicking it says when this one will be deleted.
 * The menu's row carries the same ghost in place of the chat bubble
 * (chat-nav.tsx).
 */

import { useCallback, useState } from 'react';
import Modal from '@/components/modal';
import { Icon, ICONS } from '@/components/icons';
import { chatClient } from '@/lib/chat/client';

export const TEMPORARY_NOTICE =
  'Temporary chat: it doesn’t read or save memories, and it is deleted 24 hours after its last activity.';

/** lib/chat/temporary.ts TEMPORARY_CHAT_IDLE_HOURS, which the worker's sweep keeps. */
const IDLE_MS = 24 * 60 * 60 * 1000;

export function TemporaryChatToggle({
  on,
  onChange,
  disabled = false,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      disabled={disabled}
      aria-pressed={on}
      aria-label={on ? 'Temporary chat on' : 'Temporary chat off'}
      title={
        on
          ? `${TEMPORARY_NOTICE} Click to keep it as an ordinary chat.`
          : 'Temporary chat: no memories read or saved, and deleted 24 hours after its last activity. Only before the first message.'
      }
      className={`flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium disabled:opacity-50 ${
        on
          ? 'border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200 dark:hover:bg-amber-900/40'
          : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400 dark:hover:bg-gray-800'
      }`}
    >
      <Icon path={ICONS.ghost} className="h-3.5 w-3.5" />
      <span>Temporary</span>
      {on ? <span className="sr-only">on</span> : null}
    </button>
  );
}

function formatWhen(at: Date): string {
  return at.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatIn(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return minutes <= 1 ? 'in about a minute' : `in about ${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? 'in about an hour' : `in about ${hours} hours`;
}

/**
 * The ghost in a temporary chat's title bar. The deletion time is read
 * fresh when it opens: every message moves the chat's last activity on.
 */
export function TemporaryChatMark({
  chatId,
  updatedAt,
  running,
}: {
  chatId: string;
  /** The chat's last activity as the page last knew it (ChatView.updatedAt). */
  updatedAt: string;
  /** A reply is running: the clock starts again when it finishes. */
  running: boolean;
}) {
  const [open, setOpen] = useState(false);
  // Null while the fresh read is out, so a stale time is never shown.
  const [lastActivity, setLastActivity] = useState<string | null>(null);
  const show = useCallback(async () => {
    setLastActivity(null);
    setOpen(true);
    const fresh = await chatClient.getChat(chatId);
    setLastActivity(fresh.data?.chat.updatedAt ?? updatedAt);
  }, [chatId, updatedAt]);
  const deleteAt = lastActivity ? new Date(new Date(lastActivity).getTime() + IDLE_MS) : null;
  return (
    <>
      <button
        type="button"
        onClick={() => void show()}
        aria-label="Temporary chat"
        title={TEMPORARY_NOTICE}
        data-testid="temporary-chat-mark"
        className="flex shrink-0 items-center rounded-md p-1 text-amber-600 hover:bg-amber-50 hover:text-amber-700 dark:text-amber-400 dark:hover:bg-amber-950/40 dark:hover:text-amber-300"
      >
        <Icon path={ICONS.ghost} className="h-5 w-5" />
      </button>
      {open ? (
        <Modal title="Temporary chat" onClose={() => setOpen(false)}>
          <div className="space-y-3 text-sm text-gray-700 dark:text-gray-300">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400">
                <Icon path={ICONS.ghost} className="h-6 w-6" />
              </span>
              <p>
                This chat doesn’t read or save your memories, and other chats can’t recall it. It
                still uses your own access to the organization’s tools.
              </p>
            </div>
            <p data-testid="temporary-chat-deletes-at">
              {!deleteAt ? (
                <span className="text-gray-500 dark:text-gray-400">
                  Checking when it will be deleted…
                </span>
              ) : running ? (
                <>
                  It will be deleted 24 hours after this reply finishes, unless you write in it
                  again before then.
                </>
              ) : (
                <>
                  It will be deleted on{' '}
                  <time dateTime={deleteAt.toISOString()} className="font-medium">
                    {formatWhen(deleteAt)}
                  </time>{' '}
                  ({formatIn(deleteAt.getTime() - Date.now())}) — 24 hours after its last activity.
                  Writing in it again moves that back.
                </>
              )}
            </p>
            <p className="text-gray-500 dark:text-gray-400">
              Deleted means gone, with its files: it is not archived, and it can’t be brought back.
            </p>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
