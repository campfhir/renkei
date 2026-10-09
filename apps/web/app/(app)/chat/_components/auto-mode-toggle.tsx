'use client';

/**
 * The Auto switch beside the model picker, in a code project's chat:
 * on, the chat works a task through unattended — its tools run without
 * asking, and a reply that ends with the task still open is told to
 * carry on until the model marks it complete (lib/chat/auto-mode.ts).
 * A pill that reads as pressed, with the same words in its title so a
 * person knows what they are switching on before they do.
 */

import { Icon, ICONS } from '@/components/icons';

export default function AutoModeToggle({
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
      aria-label={on ? 'Auto mode on' : 'Auto mode off'}
      title={
        on
          ? 'Auto mode is on: tools run without asking, and the chat keeps working until the task is marked complete. Click to turn it off.'
          : 'Auto mode: give the chat a task and it works until done — tools run without asking (blocked tools stay blocked), and it keeps going until it marks the task complete.'
      }
      className={`flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium disabled:opacity-50 ${
        on
          ? 'border-violet-300 bg-violet-50 text-violet-800 hover:bg-violet-100 dark:border-violet-700 dark:bg-violet-950/40 dark:text-violet-200 dark:hover:bg-violet-900/40'
          : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400 dark:hover:bg-gray-800'
      }`}
    >
      <Icon path={ICONS.loop} className="h-3.5 w-3.5" />
      <span>Auto</span>
      {on ? <span className="sr-only">on</span> : null}
    </button>
  );
}
