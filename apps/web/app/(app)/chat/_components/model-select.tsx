'use client';

/**
 * The model picker in the composer row: one button naming the model in
 * use, opening a menu of the org's models with the extended-thinking
 * switch inside it, for models that take one. Switching a model mid-chat
 * is fine — every turn resends the whole conversation anyway — and the
 * menu says as much once there is a history to resend.
 *
 * A model the person is at a token limit for (`limitReached`) is listed
 * but cannot be chosen, with the reason and the reset under its name; when
 * it is the model already in use, the button itself is marked.
 *
 * The menu never outgrows the screen: the roster scrolls inside it under
 * a search box (for a roster long enough to want one), with the thinking
 * switch and the note pinned below. What it decides is
 * model-select.model.ts; this measures, focuses and draws.
 */

import { useCallback, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { Icon, ICONS } from '@/components/icons';
import { useDismiss } from '@/lib/use-dismiss';
import type { ModelOption } from '@/lib/chat/views';
import { useCoachAnchor } from '@/components/coach-marks/anchor';
import { modelPickable } from './chat-thread.model';
import {
  closedModelSelect,
  enterPicks,
  matchingModels,
  modelSelectReducer,
  placeMenu,
  showsSearch,
  type MenuPlacement,
} from './model-select.model';

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
  const [state, dispatch] = useReducer(modelSelectReducer, closedModelSelect);
  const { open, query, activeId } = state;
  const [placement, setPlacement] = useState<MenuPlacement | null>(null);
  const modelAnchor = useCoachAnchor('chat-model');
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => dispatch({ type: 'dismissed' }), []);
  useDismiss(open, ref, close);

  // Fit the menu to the screen as it opens, and again when the screen
  // changes under it (a phone turning, its keyboard coming up).
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const button = ref.current?.getBoundingClientRect();
      if (!button) return;
      setPlacement(
        placeMenu({
          buttonLeft: button.left,
          buttonTop: button.top,
          viewportWidth: document.documentElement.clientWidth,
          contentTop: ref.current?.closest('main')?.getBoundingClientRect().top ?? 0,
        })
      );
    };
    place();
    // A pointer that types gets the search box at once; a touch screen
    // would only have its keyboard thrown up over the list.
    if (window.matchMedia('(pointer: fine)').matches) searchRef.current?.focus();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open]);

  // The row the keyboard is on stays in view as it moves.
  useLayoutEffect(() => {
    if (!open || !activeId) return;
    listRef.current
      ?.querySelector(`[data-model-id="${CSS.escape(activeId)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [open, activeId]);

  const current = models.find((model) => model.id === value) ?? null;
  if (models.length === 0) return null;
  const thinkingOn = thinking && current?.supportsThinking === true;
  const shown = matchingModels(models, query);
  const pick = (model: ModelOption) => {
    onChange(model.id);
    dispatch({ type: 'picked', supportsThinking: model.supportsThinking });
  };

  return (
    <div ref={ref} className="relative min-w-0">
      <button
        type="button"
        onClick={() => dispatch({ type: 'toggled' })}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Model"
        {...modelAnchor}
        className="flex max-w-[14rem] min-w-0 items-center gap-1.5 rounded-md border border-gray-300 bg-white px-2 py-1 text-xs hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:hover:bg-gray-800"
      >
        <span className="truncate">{current?.label ?? 'Choose a model'}</span>
        {current?.limitReached ? (
          <span
            title={current.limitReached}
            className="shrink-0 rounded bg-red-100 px-1 text-[10px] font-medium text-red-700 dark:bg-red-950/60 dark:text-red-300"
          >
            Limit reached
          </span>
        ) : null}
        {thinkingOn ? (
          <span title="Extended thinking is on" className="flex shrink-0 text-violet-500">
            <Icon path={ICONS.brain} className="h-3.5 w-3.5" />
          </span>
        ) : null}
        <Icon
          path={ICONS.chevron}
          className={`h-3.5 w-3.5 shrink-0 text-gray-400 ${open ? '-rotate-90' : 'rotate-90'}`}
        />
      </button>
      {open && placement ? (
        <div
          role="menu"
          aria-label="Model"
          style={{ left: placement.left, width: placement.width, maxHeight: placement.maxHeight }}
          className="absolute bottom-full z-40 mb-1 flex flex-col rounded-lg border border-gray-200 bg-white p-1 text-sm shadow-lg dark:border-gray-700 dark:bg-gray-900"
        >
          <p className="shrink-0 px-2 pt-1 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
            Model
          </p>
          {showsSearch(models) ? (
            <div className="relative mx-1 mb-1 shrink-0">
              <Icon
                path={ICONS.search}
                className="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400"
              />
              <input
                ref={searchRef}
                type="search"
                value={query}
                onChange={(event) =>
                  dispatch({ type: 'searched', query: event.target.value, models })
                }
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault();
                    dispatch({ type: 'moved', by: event.key === 'ArrowDown' ? 1 : -1, models });
                  } else if (event.key === 'Enter') {
                    event.preventDefault();
                    const picked = enterPicks(state, models);
                    if (picked && modelPickable(picked)) pick(picked);
                  }
                }}
                placeholder="Search models"
                aria-label="Search models"
                autoComplete="off"
                // 16px on a phone: anything smaller makes iOS zoom the page in.
                className="w-full rounded-md border border-gray-300 bg-white py-1.5 pr-2 pl-7 text-base outline-none focus:border-blue-500 sm:text-sm dark:border-gray-700 dark:bg-gray-950"
              />
            </div>
          ) : null}
          <div
            ref={listRef}
            data-testid="model-list"
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
          >
            {shown.map((model) => {
              const selected = model.id === current?.id;
              const pickable = modelPickable(model);
              return (
                <button
                  key={model.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  data-model-id={model.id}
                  disabled={!pickable}
                  onClick={() => pick(model)}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left ${
                    pickable
                      ? 'hover:bg-gray-100 dark:hover:bg-gray-800'
                      : 'cursor-not-allowed text-gray-400 dark:text-gray-600'
                  } ${model.id === activeId ? 'bg-gray-100 dark:bg-gray-800' : ''}`}
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
                    {model.limitReached ? (
                      <span className="block text-[11px] text-red-600 dark:text-red-400">
                        {model.limitReached}
                      </span>
                    ) : null}
                  </span>
                </button>
              );
            })}
            {shown.length === 0 ? (
              <p role="status" className="px-2 py-3 text-center text-xs text-gray-500">
                No model matches “{query.trim()}”.
              </p>
            ) : null}
          </div>
          {current?.supportsThinking ? (
            <div className="shrink-0">
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
            </div>
          ) : null}
          {hasHistory ? (
            <p className="shrink-0 border-t border-gray-200 px-2 pt-1.5 pb-1 text-[11px] text-gray-500 dark:border-gray-800">
              Switching resends the whole conversation to the new model.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
