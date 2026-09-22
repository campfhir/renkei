'use client';

/**
 * The two searchable pickers of the voice settings — the language, and
 * the voice — shared by the composer's speaker menu (small) and the
 * Preferences page (full size). Each is one combobox: a button showing
 * the choice, and under it a search box over a grouped list. Languages
 * group their regions ("English" → British, American, Australian…), with
 * the person's own language first; voices group under language and
 * region, the chosen language first, each row with the vendor's word on
 * the voice and a play button to hear it say a sentence in its language.
 * Typing searches all of it at once: a name, a country, "Deutsch", a word
 * like "warm" from a description.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { VoiceInfo } from '@renkei/voice';
import { Icon, ICONS } from '@/components/icons';
import { useDismiss } from '@/lib/use-dismiss';
import {
  groupLocales,
  groupVoices,
  localeLabel,
  localeMatches,
  regionLabel,
  voiceGroupLabel,
  voiceMatches,
} from '@/lib/voice/catalog';

export type PickerSize = 'sm' | 'md';

interface Group<T> {
  key: string;
  label: string;
  items: T[];
}

interface ComboboxProps<T> {
  /** For the button's label and the list's; also what a screen reader calls it. */
  label: string;
  /** What the button shows: the current choice. */
  display: ReactNode;
  groups: Group<T>[];
  keyOf: (item: T) => string;
  selectedKey: string | null;
  matches: (item: T, query: string) => boolean;
  renderItem: (item: T, active: boolean) => ReactNode;
  /** A control at the row's end that is not the choice — the play button. */
  trailing?: (item: T, active: boolean) => ReactNode;
  onSelect: (item: T) => void;
  placeholder: string;
  size: PickerSize;
  disabled?: boolean;
}

function Combobox<T>({
  label,
  display,
  groups,
  keyOf,
  selectedKey,
  matches,
  renderItem,
  trailing,
  onSelect,
  placeholder,
  size,
  disabled,
}: ComboboxProps<T>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, ref, close);

  const shown = useMemo(
    () =>
      groups
        .map((group) => ({ ...group, items: group.items.filter((item) => matches(item, query)) }))
        .filter((group) => group.items.length > 0),
    [groups, matches, query]
  );
  const flat = useMemo(() => shown.flatMap((group) => group.items), [shown]);

  // Opening: the search box takes the keyboard, and the choice is the
  // active row, so Enter keeps it and the list is scrolled to it.
  const openList = () => {
    setQuery('');
    const index = groups
      .flatMap((group) => group.items)
      .findIndex((item) => keyOf(item) === selectedKey);
    setActive(index >= 0 ? index : 0);
    setOpen(true);
  };
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const choose = (item: T) => {
    onSelect(item);
    setOpen(false);
  };

  const small = size === 'sm';
  const optionId = (index: number) => `${listId}-${index}`;
  let index = -1;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={(event) => {
          if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !open) {
            event.preventDefault();
            openList();
          }
        }}
        className={`flex w-full items-center justify-between gap-2 rounded-md border border-gray-300 bg-white text-left disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 ${
          small ? 'mt-0.5 px-2 py-1 text-sm' : 'mt-1 px-3 py-2 text-sm'
        }`}
      >
        <span className="min-w-0 flex-1 truncate">{display}</span>
        <Icon path={ICONS.chevron} className="h-4 w-4 shrink-0 text-gray-400" />
      </button>
      {open ? (
        <div
          className={`absolute left-0 z-50 mt-1 w-full rounded-md border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-900 ${
            small ? 'min-w-72' : 'min-w-80'
          }`}
        >
          <div className="border-b border-gray-100 p-1.5 dark:border-gray-800">
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  if (flat.length === 0) return;
                  setActive((current) =>
                    event.key === 'ArrowDown'
                      ? (current + 1) % flat.length
                      : (current - 1 + flat.length) % flat.length
                  );
                } else if (event.key === 'Enter') {
                  event.preventDefault();
                  const item = flat[active];
                  if (item !== undefined) choose(item);
                } else if (event.key === 'Escape') {
                  // Only the picker closes; the menu around it stays open.
                  // Its dismiss listener sits on document, the same node
                  // React's own do under the app router, so only an
                  // immediate stop keeps the key from reaching it.
                  event.preventDefault();
                  event.nativeEvent.stopImmediatePropagation();
                  setOpen(false);
                }
              }}
              role="searchbox"
              aria-label={`Search ${label.toLowerCase()}`}
              aria-controls={listId}
              aria-activedescendant={flat.length > 0 ? optionId(active) : undefined}
              placeholder={placeholder}
              className="w-full rounded border border-gray-200 bg-white px-2 py-1 text-sm focus:ring-1 focus:ring-blue-500 focus:outline-none dark:border-gray-700 dark:bg-gray-950"
            />
          </div>
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label={label}
            className={`overflow-y-auto p-1 ${small ? 'max-h-64' : 'max-h-80'}`}
          >
            {flat.length === 0 ? (
              <div className="px-2 py-1.5 text-xs text-gray-500 dark:text-gray-400">
                Nothing matches “{query}”.
              </div>
            ) : (
              shown.map((group) => (
                <div key={group.key} role="group" aria-label={group.label}>
                  <div
                    role="presentation"
                    className="px-2 pt-1.5 pb-0.5 text-[0.65rem] font-semibold tracking-wide text-gray-400 uppercase"
                  >
                    {group.label}
                  </div>
                  {group.items.map((item) => {
                    index += 1;
                    const thisIndex = index;
                    const isActive = thisIndex === active;
                    const key = keyOf(item);
                    return (
                      <div
                        key={key}
                        id={optionId(thisIndex)}
                        data-index={thisIndex}
                        role="option"
                        aria-selected={key === selectedKey}
                        onMouseEnter={() => setActive(thisIndex)}
                        className={`flex items-center gap-1 rounded ${
                          isActive ? 'bg-blue-600 text-white' : 'text-gray-800 dark:text-gray-200'
                        }`}
                      >
                        {/* mousedown, not click: the search box keeps focus. */}
                        <button
                          type="button"
                          tabIndex={-1}
                          onMouseDown={(event) => {
                            event.preventDefault();
                            choose(item);
                          }}
                          className="min-w-0 flex-1 px-2 py-1.5 text-left"
                        >
                          {renderItem(item, isActive)}
                        </button>
                        {key === selectedKey ? (
                          <Icon
                            path={ICONS.check}
                            className={`h-4 w-4 shrink-0 ${isActive ? 'text-white' : 'text-blue-600 dark:text-blue-400'}`}
                            strokeWidth={2.4}
                          />
                        ) : null}
                        {trailing ? trailing(item, isActive) : null}
                      </div>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function LanguagePicker({
  locales,
  value,
  defaultLocale,
  onChange,
  size,
  disabled,
}: {
  /** Every locale on offer — the voices' and the defaults. */
  locales: string[];
  /** The chosen locale, resolved (never null). */
  value: string;
  defaultLocale: string;
  onChange: (locale: string) => void;
  size: PickerSize;
  disabled?: boolean;
}) {
  const groups = useMemo(
    () =>
      groupLocales(locales, value).map((group) => ({
        key: group.language,
        label: group.label,
        items: group.locales,
      })),
    [locales, value]
  );
  return (
    <Combobox<string>
      label="Language"
      display={
        <>
          {voiceGroupLabel(value)}
          {value === defaultLocale ? <span className="text-gray-500"> · default</span> : null}
        </>
      }
      groups={groups}
      keyOf={(locale) => locale}
      selectedKey={value}
      matches={localeMatches}
      renderItem={(locale, active) => (
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate">
            {regionLabel(locale) ?? localeLabel(locale)}
          </span>
          <span
            className={`text-xs ${active ? 'text-blue-100' : 'text-gray-500 dark:text-gray-400'}`}
          >
            {locale}
            {locale === defaultLocale ? ' · default' : ''}
          </span>
        </span>
      )}
      onSelect={onChange}
      placeholder="Search languages and countries…"
      size={size}
      disabled={disabled}
    />
  );
}

/** A row of the voice list: a voice, or the org's default in its place. */
type VoiceRow = { kind: 'default'; voice: VoiceInfo | null } | { kind: 'voice'; voice: VoiceInfo };

const DEFAULT_KEY = '';

function rowKey(row: VoiceRow): string {
  return row.kind === 'default' ? DEFAULT_KEY : row.voice.id;
}

export function VoicePicker({
  voices,
  value,
  defaultVoice,
  locale,
  onChange,
  previewing,
  onPreview,
  size,
  disabled,
}: {
  voices: VoiceInfo[];
  /** The chosen voice id; null is the org's default. */
  value: string | null;
  defaultVoice: string;
  /** The chosen language: its voices lead the list. */
  locale: string;
  onChange: (voice: VoiceInfo | null) => void;
  /** The voice being played right now, if any; its play button shows Stop. */
  previewing: string | null;
  /** Play (or stop) a voice's sample sentence. */
  onPreview: (voice: VoiceInfo) => void;
  size: PickerSize;
  disabled?: boolean;
}) {
  const fallback = useMemo(
    () => voices.find((voice) => voice.id === defaultVoice) ?? null,
    [voices, defaultVoice]
  );
  const chosen = useMemo(
    () => (value ? (voices.find((voice) => voice.id === value) ?? null) : null),
    [voices, value]
  );
  const groups = useMemo<Group<VoiceRow>[]>(
    () => [
      {
        key: DEFAULT_KEY,
        label: 'Organization default',
        items: [{ kind: 'default', voice: fallback }],
      },
      ...groupVoices(voices, locale).map((group) => ({
        key: group.locale,
        label: group.label,
        items: group.voices.map((voice): VoiceRow => ({ kind: 'voice', voice })),
      })),
    ],
    [voices, locale, fallback]
  );
  const matches = useCallback(
    (row: VoiceRow, query: string) =>
      row.kind === 'default'
        ? !query.trim() || (row.voice !== null && voiceMatches(row.voice, query))
        : voiceMatches(row.voice, query),
    []
  );
  const small = size === 'sm';
  const describe = (voice: VoiceInfo, active: boolean, showLocale: boolean) => (
    <span className="block">
      <span className="flex items-baseline gap-1.5">
        <span className="min-w-0 truncate font-medium">{voice.name}</span>
        {voice.gender ? (
          <span
            className={`text-xs ${active ? 'text-blue-100' : 'text-gray-500 dark:text-gray-400'}`}
          >
            {voice.gender}
          </span>
        ) : null}
        {voice.multilingual ? (
          <span
            className={`rounded px-1 text-[0.65rem] ${
              active
                ? 'bg-blue-500 text-white'
                : 'bg-violet-100 text-violet-800 dark:bg-violet-950/60 dark:text-violet-200'
            }`}
          >
            multilingual
          </span>
        ) : null}
        {showLocale ? (
          <span
            className={`text-xs ${active ? 'text-blue-100' : 'text-gray-500 dark:text-gray-400'}`}
          >
            {voice.locale}
          </span>
        ) : null}
      </span>
      {voice.description ? (
        <span
          className={`block truncate text-xs ${active ? 'text-blue-100' : 'text-gray-500 dark:text-gray-400'}`}
        >
          {voice.description}
        </span>
      ) : null}
    </span>
  );

  return (
    <Combobox<VoiceRow>
      label="Voice"
      display={
        value === null || !chosen ? (
          <>
            Default{fallback ? ` · ${fallback.name}` : ` (${defaultVoice})`}
            {value !== null && !chosen ? (
              <span className="text-gray-500"> · {value} is not offered any more</span>
            ) : null}
          </>
        ) : (
          <>
            {chosen.name}
            {chosen.gender ? <span className="text-gray-500"> · {chosen.gender}</span> : null}
            {chosen.locale !== locale ? (
              <span className="text-gray-500"> · {chosen.locale}</span>
            ) : null}
          </>
        )
      }
      groups={groups}
      keyOf={rowKey}
      selectedKey={value ?? DEFAULT_KEY}
      matches={matches}
      renderItem={(row, active) =>
        row.kind === 'default' ? (
          <span className="block">
            <span className="block font-medium">
              Default{row.voice ? ` · ${row.voice.name}` : ''}
            </span>
            <span
              className={`block truncate text-xs ${active ? 'text-blue-100' : 'text-gray-500 dark:text-gray-400'}`}
            >
              {row.voice
                ? (row.voice.description ??
                  `${row.voice.locale}${row.voice.multilingual ? ' · multilingual' : ''}`)
                : defaultVoice}
            </span>
          </span>
        ) : (
          describe(row.voice, active, false)
        )
      }
      trailing={(row, active) => {
        const voice = row.voice;
        if (!voice) return null;
        const playing = previewing === voice.id;
        return (
          <button
            type="button"
            tabIndex={-1}
            aria-label={playing ? `Stop ${voice.name}` : `Hear ${voice.name}`}
            title={playing ? 'Stop' : 'Hear a sample'}
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.stopPropagation();
              onPreview(voice);
            }}
            className={`mr-1 flex shrink-0 items-center justify-center rounded-full p-1 ${
              active
                ? 'text-white hover:bg-blue-500'
                : 'text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800'
            } ${small ? '' : 'p-1.5'}`}
          >
            <Icon path={playing ? ICONS.stop : ICONS.play} className="h-4 w-4" />
          </button>
        );
      }}
      onSelect={(row) => onChange(row.kind === 'default' ? null : row.voice)}
      placeholder="Search voices, languages, countries, or a word like “warm”…"
      size={size}
      disabled={disabled}
    />
  );
}
