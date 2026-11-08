'use client';

/**
 * Pick a prompt from the libraries this person can see — theirs, shared
 * with them, or published to the org — and drop its body into the
 * composer. In a code project's chat the code libraries are offered too.
 *
 * Built for long lists: results are grouped under their library, each
 * group folds after a few rows, a library filter narrows to one, and the
 * arrow keys walk the rows from the search box. What the list shows and
 * which row Enter takes is `prompt-picker.model.ts`.
 */

import { useEffect, useReducer, useRef } from 'react';
import Modal from '@/components/modal';
import { getJson } from '@/lib/fetch-json';
import { LoadingLine } from '@/components/skeleton';
import { Icon, ICONS } from '@/components/icons';
import {
  GROUP_LIMIT,
  activePrompt,
  emptyMessage,
  initialPicker,
  pickerGroups,
  pickerLibraries,
  pickerReducer,
  showLibraryFilter,
  visibleRows,
  type PickerPrompt,
} from './prompt-picker.model';

const COMPACT_COMMAND = {
  title: 'Compact this conversation',
  detail: '/compact · summarize the older part of this chat to free up context',
};

export default function PromptPicker({
  inCodeProject = false,
  onClose,
  onPick,
  onCompact,
}: {
  /** A code project's chat is offered the code libraries as well. */
  inCodeProject?: boolean;
  onClose: () => void;
  onPick: (prompt: PickerPrompt) => void;
  /** Runs a compaction pass instead of inserting text. */
  onCompact: () => void;
}) {
  const [state, dispatch] = useReducer(pickerReducer, undefined, initialPicker);
  const activeRef = useRef<HTMLButtonElement | null>(null);
  const showCompact = 'compact'.includes(state.query.trim().toLowerCase());

  useEffect(() => {
    void getJson<{ prompts: PickerPrompt[] }>(
      `/api/chat/prompt-libraries/picker${inCodeProject ? '?context=code' : ''}`
    ).then((result) => {
      if (result.error) dispatch({ type: 'failed', error: result.error });
      else dispatch({ type: 'loaded', prompts: result.data?.prompts ?? [] });
    });
  }, [inCodeProject]);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [state.active, state.query, state.libraryId]);

  const groups = pickerGroups(state);
  const rows = visibleRows(state);
  const empty = emptyMessage(state);
  const active = activePrompt(state);
  const libraries = pickerLibraries(state);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      dispatch({ type: 'moved', by: 1 });
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      dispatch({ type: 'moved', by: -1 });
    } else if (event.key === 'Home' && event.ctrlKey) {
      event.preventDefault();
      dispatch({ type: 'movedTo', to: 'first' });
    } else if (event.key === 'End' && event.ctrlKey) {
      event.preventDefault();
      dispatch({ type: 'movedTo', to: 'last' });
    } else if (event.key === 'Enter' && active) {
      event.preventDefault();
      onPick(active);
    }
  };

  return (
    <Modal title="Insert a prompt" onClose={onClose}>
      <div className="mb-2 flex gap-2">
        <input
          autoFocus
          value={state.query}
          onChange={(event) => dispatch({ type: 'queryChanged', query: event.target.value })}
          onKeyDown={onKeyDown}
          placeholder="Search prompts"
          role="combobox"
          aria-expanded="true"
          aria-controls="prompt-picker-list"
          aria-activedescendant={active ? `prompt-option-${active.id}` : undefined}
          className="min-w-0 flex-1 rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900"
        />
        {showLibraryFilter(state) ? (
          <select
            value={state.libraryId ?? ''}
            onChange={(event) =>
              dispatch({ type: 'libraryChosen', libraryId: event.target.value || null })
            }
            aria-label="Library"
            className="max-w-[40%] rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900"
          >
            <option value="">All libraries</option>
            {libraries.map((library) => (
              <option key={library.id} value={library.id}>
                {library.name} ({library.count})
              </option>
            ))}
          </select>
        ) : null}
      </div>
      {state.error ? <p className="text-sm text-red-600">{state.error}</p> : null}
      <div
        id="prompt-picker-list"
        role="listbox"
        aria-label="Prompts"
        className="max-h-96 overflow-y-auto"
      >
        {showCompact ? (
          <button
            type="button"
            onClick={onCompact}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            <Icon path={ICONS.package} className="h-4 w-4 shrink-0 text-gray-500" />
            <span className="min-w-0">
              <span className="block text-sm font-medium">{COMPACT_COMMAND.title}</span>
              <span className="block truncate text-xs text-gray-500">{COMPACT_COMMAND.detail}</span>
            </span>
          </button>
        ) : null}
        {state.prompts === null ? (
          <LoadingLine label="Loading prompts…" />
        ) : empty ? (
          showCompact ? null : (
            <p className="text-sm text-gray-500">{empty}</p>
          )
        ) : (
          groups.map((group) => (
            <section key={group.libraryId} aria-label={group.libraryName} className="mb-1">
              <h3 className="sticky top-0 z-10 flex items-center gap-2 bg-white px-2 pt-1.5 pb-2 text-xs font-semibold tracking-wide text-gray-500 uppercase dark:bg-gray-950">
                <span className="min-w-0 truncate">{group.libraryName}</span>
                {group.libraryScope === 'code' ? (
                  <span className="rounded border border-gray-300 px-1 text-[10px] font-medium normal-case dark:border-gray-700">
                    code
                  </span>
                ) : null}
                <span className="ml-auto font-normal normal-case">{group.total}</span>
              </h3>
              {group.rows.map((prompt) => {
                const index = rows.indexOf(prompt);
                const isActive = index === state.active;
                return (
                  <button
                    key={prompt.id}
                    id={`prompt-option-${prompt.id}`}
                    ref={isActive ? activeRef : undefined}
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    tabIndex={-1}
                    onClick={() => onPick(prompt)}
                    onMouseMove={() => {
                      if (!isActive) dispatch({ type: 'pointed', index });
                    }}
                    className={`block w-full rounded-md px-2 py-1.5 text-left ${
                      isActive ? 'bg-gray-100 dark:bg-gray-800' : ''
                    }`}
                  >
                    <span className="block text-sm font-medium">{prompt.title}</span>
                    <span className="block truncate text-xs text-gray-500">
                      {prompt.body.replace(/\s+/g, ' ').slice(0, 90)}
                    </span>
                  </button>
                );
              })}
              {group.total > GROUP_LIMIT && state.libraryId === null ? (
                <button
                  type="button"
                  onClick={() => dispatch({ type: 'groupToggled', libraryId: group.libraryId })}
                  aria-expanded={group.expanded}
                  className="px-2 py-1 text-xs text-blue-700 hover:underline dark:text-blue-300"
                >
                  {group.expanded ? 'Show fewer' : `Show all ${group.total}`}
                </button>
              ) : null}
            </section>
          ))
        )}
      </div>
      <p className="mt-2 hidden text-[11px] text-gray-400 sm:block">
        ↑↓ to move, Enter to insert, Esc to close.
      </p>
    </Modal>
  );
}
