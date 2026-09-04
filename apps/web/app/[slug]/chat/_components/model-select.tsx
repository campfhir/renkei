'use client';

/**
 * The model picker in the composer row: one button naming the model in
 * use, opening a menu of the org's models with the extended-thinking
 * switch inside it, for models that take one. Switching a model mid-chat
 * is fine — every turn resends the whole conversation anyway — and the
 * menu says as much once there is a history to resend.
 */

import { useCallback, useRef, useState } from 'react';
import { Icon, ICONS } from '@/components/icons';
import { useDismiss } from '@/lib/use-dismiss';
import type { ModelOption } from '@/lib/chat/views';

export default function ModelSelect({
  models,
  value,
  onChange,
  thinking,
  onThinking,
  hasHistory,
}: {
  models: ModelOption[];
  value: string | null;
  onChange: (id: string) => void;
  thinking: boolean;
  onThinking: (on: boolean) => void;
  hasHistory: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, ref, close);

  const current = models.find((model) => model.id === value) ?? null;
  if (models.length === 0) return null;
  const thinkingOn = thinking && current?.supportsThinking === true;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((state) => !state)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Model"
        className="flex max-w-[14rem] items-center gap-1.5 rounded-md border border-gray-300 bg-white px-2 py-1 text-xs hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:hover:bg-gray-800"
      >
        <span className="truncate">{current?.label ?? 'Choose a model'}</span>
        {thinkingOn ? (
          <span title="Extended thinking is on" className="flex shrink-0 text-violet-500">
            <Icon path={ICONS.sparkle} className="h-3.5 w-3.5" />
          </span>
        ) : null}
        <Icon
          path={ICONS.chevron}
          className={`h-3.5 w-3.5 shrink-0 text-gray-400 ${open ? '-rotate-90' : 'rotate-90'}`}
        />
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute bottom-full left-0 z-40 mb-1 w-72 rounded-lg border border-gray-200 bg-white p-1 text-sm shadow-lg dark:border-gray-700 dark:bg-gray-900"
        >
          <p className="px-2 pt-1 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
            Model
          </p>
          {models.map((model) => {
            const selected = model.id === current?.id;
            return (
              <button
                key={model.id}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                onClick={() => {
                  onChange(model.id);
                  if (!model.supportsThinking) setOpen(false);
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-gray-100 dark:hover:bg-gray-800"
              >
                <span className="flex h-4 w-4 shrink-0 items-center justify-center text-blue-600 dark:text-blue-400">
                  {selected ? (
                    <Icon path={ICONS.check} className="h-4 w-4" strokeWidth={2.4} />
                  ) : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{model.label}</span>
                  <span className="block truncate text-[11px] text-gray-500">
                    {model.provider} · {model.model}
                    {model.isDefault ? ' · default' : ''}
                  </span>
                </span>
              </button>
            );
          })}
          {current?.supportsThinking ? (
            <>
              <div className="my-1 border-t border-gray-200 dark:border-gray-800" />
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={thinking}
                onClick={() => onThinking(!thinking)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-gray-100 dark:hover:bg-gray-800"
              >
                <span className="flex h-4 w-4 shrink-0 items-center justify-center text-blue-600 dark:text-blue-400">
                  {thinking ? (
                    <Icon path={ICONS.check} className="h-4 w-4" strokeWidth={2.4} />
                  ) : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block">Extended thinking</span>
                  <span className="block text-[11px] text-gray-500">
                    Lets the model reason before it answers; uses part of the reply budget.
                  </span>
                </span>
              </button>
            </>
          ) : null}
          {hasHistory ? (
            <p className="border-t border-gray-200 px-2 pt-1.5 pb-1 text-[11px] text-gray-500 dark:border-gray-800">
              Switching resends the whole conversation to the new model.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
