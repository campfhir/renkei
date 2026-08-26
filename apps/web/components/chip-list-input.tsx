'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import RemoveButton from '@/components/remove-button';

/**
 * A list of values, entered as chips — the app's first multi-select.
 *
 * Two shapes, one component, because they differ only in where values come
 * from and the difference should not be two components to keep in step:
 *
 *  - **typed** (`allowFreeText`) — addresses, names, anything the person
 *    knows. Enter commits what was typed.
 *  - **picked** (`loadOptions`) — values the provider owns, where the thing
 *    a person recognises (a space's title) and the thing we must store (its
 *    opaque id) are different. Typing an id is still allowed where it makes
 *    sense: a picker that cannot list something must not make it
 *    unreachable.
 *
 * The two compose. A mail sender list is typed WITH a directory to search,
 * and the directory is a convenience, never a gate — no directory has every
 * address somebody might want to filter on.
 *
 * `emptyMeans` exists because an empty list is ambiguous in exactly the way
 * that matters here: it could read as "nothing gets through". Every caller
 * must say what empty does, in words, on the screen.
 */

export interface ChipOption {
  /** The value stored. For a picker this is the provider's id. */
  key: string;
  /** What a person recognises. */
  label: string;
  hint?: string;
}

export default function ChipListInput({
  values,
  onChange,
  label,
  hint,
  placeholder,
  max,
  normalize,
  validate,
  allowFreeText = true,
  loadOptions,
  browseLabel,
  searchPlaceholder,
  emptyMeans,
  disabled = false,
}: {
  values: string[];
  onChange: (next: string[]) => void;
  label: string;
  hint?: string;
  placeholder?: string;
  max?: number;
  /** Applied before a value is stored, so the list is canonical as typed. */
  normalize?: (raw: string) => string;
  /** Returns a problem to show, or null. Runs on the normalized value. */
  validate?: (value: string) => string | null;
  allowFreeText?: boolean;
  /**
   * Fetches options for a query. Called lazily — on first browse, and once
   * on mount when the list already holds values, so stored ids can be shown
   * as the names they were chosen by rather than as raw ids.
   */
  loadOptions?: (query: string) => Promise<ChipOption[]>;
  /** The browse button's wording, e.g. "Choose from your spaces". */
  browseLabel?: string;
  searchPlaceholder?: string;
  /** What an empty list means, in words. Required — see the note above. */
  emptyMeans: string;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<ChipOption[] | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /**
   * key → label for everything we have ever seen from the picker. Kept
   * outside `options` so a chip stays readable after a search narrows the
   * option list away from it.
   */
  const knownLabels = useRef(new Map<string, string>());

  const atCapacity = max !== undefined && values.length >= max;

  const fetchOptions = useCallback(
    async (q: string) => {
      if (!loadOptions) return;
      setLoading(true);
      setOptionsError(null);
      try {
        const found = await loadOptions(q);
        for (const option of found) knownLabels.current.set(option.key, option.label);
        setOptions(found);
      } catch (error) {
        setOptions([]);
        setOptionsError(error instanceof Error ? error.message : 'Could not load the list.');
      } finally {
        setLoading(false);
      }
    },
    [loadOptions]
  );

  // One resolve pass on mount when there is something to name. Best-effort:
  // a failure leaves the chips showing their stored values, which is worse
  // to read but never wrong, and never blocks editing.
  const resolved = useRef(false);
  useEffect(() => {
    if (resolved.current || !loadOptions || values.length === 0) return;
    resolved.current = true;
    void fetchOptions('');
  }, [fetchOptions, loadOptions, values.length]);

  function commit(raw: string) {
    const value = normalize ? normalize(raw) : raw.trim();
    if (!value) return;
    if (values.includes(value)) {
      setDraft('');
      setProblem(null);
      return;
    }
    if (atCapacity) {
      setProblem(`This list holds at most ${max}.`);
      return;
    }
    const failure = validate?.(value) ?? null;
    if (failure) {
      setProblem(failure);
      return;
    }
    onChange([...values, value]);
    setDraft('');
    setProblem(null);
  }

  function toggle(key: string) {
    if (values.includes(key)) {
      onChange(values.filter((value) => value !== key));
      return;
    }
    if (atCapacity) {
      setProblem(`This list holds at most ${max}.`);
      return;
    }
    onChange([...values, key]);
    setProblem(null);
  }

  const nameOf = (value: string) => knownLabels.current.get(value) ?? value;

  return (
    <div>
      <p className="text-sm font-medium">{label}</p>
      {hint ? <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{hint}</p> : null}

      {values.length === 0 ? (
        <p className="mt-1.5 text-xs italic text-gray-500 dark:text-gray-400">{emptyMeans}</p>
      ) : (
        <ul className="mt-1.5 flex flex-wrap items-center gap-1">
          {values.map((value) => (
            <li
              key={value}
              className="inline-flex max-w-full items-center gap-0.5 rounded-full border border-violet-300 bg-violet-50 py-0.5 pl-2 pr-0.5 text-xs text-violet-700 dark:border-violet-800 dark:bg-violet-950 dark:text-violet-300"
            >
              <span className="truncate" title={value}>
                {nameOf(value)}
              </span>
              <RemoveButton
                compact
                label="Remove"
                accessibleLabel={`Remove ${nameOf(value)} from ${label}`}
                disabled={disabled}
                onClick={() => onChange(values.filter((entry) => entry !== value))}
              />
            </li>
          ))}
        </ul>
      )}

      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        {allowFreeText ? (
          <input
            value={draft}
            disabled={disabled}
            placeholder={placeholder}
            aria-label={`Add to ${label}`}
            onChange={(event) => {
              setDraft(event.target.value);
              setProblem(null);
            }}
            onBlur={() => commit(draft)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commit(draft);
                return;
              }
              // Backspace on an empty box removes the last chip — the
              // convention every chip input has, and the only way to undo a
              // typo without reaching for the mouse.
              if (event.key === 'Backspace' && draft === '' && values.length > 0) {
                onChange(values.slice(0, -1));
              }
            }}
            className="min-w-0 flex-1 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900"
          />
        ) : null}

        {loadOptions ? (
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              const next = !browsing;
              setBrowsing(next);
              if (next && options === null) void fetchOptions('');
            }}
            className="shrink-0 rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-900"
          >
            {browsing ? 'Done choosing' : (browseLabel ?? 'Choose…')}
          </button>
        ) : null}
      </div>

      {problem ? <p className="mt-1 text-xs text-red-600 dark:text-red-400">{problem}</p> : null}

      {loadOptions && browsing ? (
        <div className="mt-2">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void fetchOptions(query);
            }}
            className="flex items-center gap-2"
          >
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={searchPlaceholder ?? 'Search…'}
              aria-label={`Search ${label}`}
              className="min-w-0 flex-1 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900"
            />
            <button
              type="submit"
              className="shrink-0 rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-900"
            >
              Search
            </button>
          </form>

          {optionsError ? (
            <p className="mt-2 text-xs text-red-600 dark:text-red-400">{optionsError}</p>
          ) : null}

          <ul className="mt-2 max-h-56 space-y-0.5 overflow-y-auto rounded-md border border-gray-200 p-2 dark:border-gray-800">
            {loading ? (
              <li className="px-1 py-0.5 text-xs text-gray-400">Loading…</li>
            ) : (options?.length ?? 0) === 0 ? (
              <li className="px-1 py-0.5 text-xs text-gray-400">
                {optionsError ? 'Nothing to show.' : 'Nothing matched.'}
              </li>
            ) : (
              options?.map((option) => (
                <li key={option.key}>
                  <label
                    className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-gray-50 dark:hover:bg-gray-900"
                    title={option.hint ?? option.label}
                  >
                    <input
                      type="checkbox"
                      checked={values.includes(option.key)}
                      onChange={() => toggle(option.key)}
                    />
                    <span className="min-w-0 truncate">{option.label}</span>
                    {option.hint ? (
                      <span className="ml-auto shrink-0 text-[10px] uppercase text-gray-400">
                        {option.hint}
                      </span>
                    ) : null}
                  </label>
                </li>
              ))
            )}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
