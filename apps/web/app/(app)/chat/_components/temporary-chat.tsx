'use client';

/**
 * A temporary chat (lib/chat/temporary.ts): the switch on an empty chat's
 * composer that makes it one, or stops it being one, before its first
 * message — and the notice the chat shows from then on, so nobody forgets
 * it neither reads nor keeps memories and is deleted after a quiet day.
 */

import { Icon, ICONS } from '@/components/icons';

export const TEMPORARY_NOTICE =
  'Temporary chat: it doesn’t read or save memories, and it is deleted 24 hours after its last activity.';

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
      <Icon path={ICONS.clock} className="h-3.5 w-3.5" />
      <span>Temporary</span>
      {on ? <span className="sr-only">on</span> : null}
    </button>
  );
}

export function TemporaryChatNotice() {
  return (
    <div
      data-testid="temporary-chat-notice"
      role="status"
      className="flex items-center gap-2 border-t border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-200"
    >
      <Icon path={ICONS.clock} className="h-3.5 w-3.5 shrink-0" />
      <span>{TEMPORARY_NOTICE}</span>
    </div>
  );
}
