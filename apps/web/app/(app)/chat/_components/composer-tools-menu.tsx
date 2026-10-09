'use client';

/**
 * The composer's tools as one button, for a phone: in a code project the
 * row also carries the model and the Auto switch, so prompt libraries, the
 * microphone and the speaker fold into a single menu of two levels — the
 * first names them (Prompt libraries, Dictate, Voice), the second is the
 * voice panel itself, with a way back. Prompt libraries and Dictate act at
 * once; only Voice has more to show. While dictating, the button is the
 * microphone: one tap stops it.
 *
 * The composer draws this below the `sm` breakpoint only (its separate
 * buttons come back above it), and only when there is more than the
 * prompt picker to fold in.
 */

import { useCallback, useRef, useState, type ReactNode } from 'react';
import { Icon, ICONS } from '@/components/icons';
import { useDismiss } from '@/lib/use-dismiss';

export default function ComposerToolsMenu({
  disabled,
  dictating,
  wave,
  canDictate,
  onPrompts,
  onToggleDictation,
  voicePanel,
  onVoiceOpen,
}: {
  disabled: boolean;
  dictating: boolean;
  /** What the button shows while dictating: the bars that follow the microphone. */
  wave: ReactNode;
  canDictate: boolean;
  onPrompts: () => void;
  onToggleDictation: () => void;
  /** The voice panel, as the menu's second level; absent when the org has no speaker menu. */
  voicePanel?: (level: { onBack: () => void; onClose: () => void }) => ReactNode;
  /** The click that opens the voice level, to unlock playback. */
  onVoiceOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [level, setLevel] = useState<'tools' | 'voice'>('tools');
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => {
    setOpen(false);
    setLevel('tools');
  }, []);
  useDismiss(open, ref, close);

  const item =
    'flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-800';

  return (
    <div ref={ref} className="relative sm:hidden">
      <button
        type="button"
        onClick={() => {
          if (dictating) {
            onToggleDictation();
            return;
          }
          setLevel('tools');
          setOpen((state) => !state);
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={dictating ? 'Stop dictating' : 'Prompts and voice'}
        title={dictating ? 'Stop dictating' : 'Prompts and voice'}
        disabled={disabled}
        className={`flex items-center justify-center rounded-md p-1.5 disabled:opacity-40 ${
          dictating
            ? 'bg-rose-50 text-rose-600 hover:bg-rose-100 dark:bg-rose-950/40 dark:text-rose-300 dark:hover:bg-rose-900/40'
            : 'text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800'
        }`}
      >
        {dictating ? wave : <Icon path={ICONS.sparkle} className="h-5 w-5" />}
      </button>
      {open && level === 'tools' ? (
        <div
          role="menu"
          aria-label="Prompts and voice"
          className="absolute bottom-full left-0 z-40 mb-1 w-64 rounded-lg border border-gray-200 bg-white p-1 text-sm shadow-lg dark:border-gray-700 dark:bg-gray-900"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              close();
              onPrompts();
            }}
            className={item}
          >
            <Icon path={ICONS.sparkle} className="h-4 w-4 shrink-0 text-gray-500" />
            <span className="flex-1">Prompt libraries</span>
          </button>
          {canDictate ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                close();
                onToggleDictation();
              }}
              className={item}
            >
              <Icon path={ICONS.microphone} className="h-4 w-4 shrink-0 text-gray-500" />
              <span className="flex-1">Dictate</span>
            </button>
          ) : null}
          {voicePanel ? (
            <button
              type="button"
              role="menuitem"
              aria-haspopup="menu"
              onClick={() => {
                onVoiceOpen?.();
                setLevel('voice');
              }}
              className={item}
            >
              <Icon path={ICONS.speaker} className="h-4 w-4 shrink-0 text-gray-500" />
              <span className="flex-1">Voice</span>
              <Icon path={ICONS.chevron} className="h-4 w-4 shrink-0 text-gray-400" />
            </button>
          ) : null}
        </div>
      ) : null}
      {open && level === 'voice' && voicePanel
        ? voicePanel({ onBack: () => setLevel('tools'), onClose: close })
        : null}
    </div>
  );
}
