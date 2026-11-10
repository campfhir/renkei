/**
 * The voice settings' two searchable pickers (voice-picker.tsx) and the
 * rules of choosing in them, shared by the composer's speaker menu
 * (voice-menu.tsx) and the Preferences page (preferences/voice-form.tsx),
 * with no DOM or React: the combobox's open/search/active row, what a
 * search leaves in each group, the voice list's rows (the org default
 * first, then the chosen language's voices), what the closed picker
 * shows, and what choosing a language or a voice does to the other.
 * The grouping and matching themselves are lib/voice/catalog.ts's.
 * Tested in voice-picker.model.test.ts.
 */

import type { VoicePrefs } from '@renkei/user-prefs/prefs';
import type { VoiceInfo } from '@renkei/voice';
import { groupVoices, voiceMatches, voiceSpeaks } from '@/lib/voice/catalog';

export interface Group<T> {
  key: string;
  label: string;
  items: T[];
}

/* --------------------------------------------------------------------- */
/* The combobox                                                          */

export interface ComboboxState {
  open: boolean;
  query: string;
  /** The highlighted row, by its place among the rows shown. */
  active: number;
}

export const initialCombobox: ComboboxState = { open: false, query: '', active: 0 };

export type ComboboxAction =
  /** Opened: the search is empty and the current choice is the active row. */
  | { type: 'open'; selectedIndex: number }
  /** Closed: by Escape, a choice, a press outside, or the button again. */
  | { type: 'close' }
  | { type: 'search'; query: string }
  /** An arrow key, over the `count` rows shown: wraps at either end. */
  | { type: 'move'; by: 1 | -1; count: number }
  /** The pointer is over row `index`. */
  | { type: 'hover'; index: number };

export function comboboxReducer(state: ComboboxState, action: ComboboxAction): ComboboxState {
  switch (action.type) {
    case 'open':
      return { open: true, query: '', active: Math.max(action.selectedIndex, 0) };
    case 'close':
      return state.open ? { ...state, open: false } : state;
    case 'search':
      return { ...state, query: action.query, active: 0 };
    case 'move':
      if (action.count === 0) return state;
      return { ...state, active: (state.active + action.by + action.count) % action.count };
    case 'hover':
      return { ...state, active: action.index };
  }
}

/** The groups a search leaves, each with only its matching items; empty groups go. */
export function shownGroups<T>(
  groups: Group<T>[],
  matches: (item: T, query: string) => boolean,
  query: string
): Group<T>[] {
  return groups
    .map((group) => ({ ...group, items: group.items.filter((item) => matches(item, query)) }))
    .filter((group) => group.items.length > 0);
}

/** Every item shown, in order: what the arrows walk and Enter picks from. */
export function flatItems<T>(groups: Group<T>[]): T[] {
  return groups.flatMap((group) => group.items);
}

/** Where the current choice sits in the unfiltered list; -1 when it is not there. */
export function selectedIndex<T>(
  groups: Group<T>[],
  keyOf: (item: T) => string,
  selectedKey: string | null
): number {
  return flatItems(groups).findIndex((item) => keyOf(item) === selectedKey);
}

/* --------------------------------------------------------------------- */
/* The voice list                                                        */

/** A row of the voice list: a voice, or the org's default in its place. */
export type VoiceRow =
  { kind: 'default'; voice: VoiceInfo | null } | { kind: 'voice'; voice: VoiceInfo };

export const DEFAULT_KEY = '';

export function rowKey(row: VoiceRow): string {
  return row.kind === 'default' ? DEFAULT_KEY : row.voice.id;
}

/**
 * The voice list: the organization's default first (the voice it stands
 * for, when the vendor offers it), then every voice under its language
 * and region, the chosen language's first.
 */
export function voiceRowGroups(
  voices: VoiceInfo[],
  locale: string,
  defaultVoice: string
): Group<VoiceRow>[] {
  const fallback = voices.find((voice) => voice.id === defaultVoice) ?? null;
  return [
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
  ];
}

/** A search finds the default row only by the voice it stands for; an empty one shows it. */
export function voiceRowMatches(row: VoiceRow, query: string): boolean {
  return row.kind === 'default'
    ? !query.trim() || (row.voice !== null && voiceMatches(row.voice, query))
    : voiceMatches(row.voice, query);
}

/** What the closed voice picker shows. */
export type VoiceDisplay =
  | {
      kind: 'default';
      /** "Default · Ava" or "Default (en-US-AvaNeural)" when the vendor does not list it. */
      text: string;
      /** The chosen voice is no longer offered: it is named, and the default plays meanwhile. */
      missing: string | null;
    }
  | {
      kind: 'voice';
      name: string;
      gender: string | null;
      /** The voice's own language, shown when it is not the chosen one. */
      locale: string | null;
    };

export function voiceDisplay(input: {
  voices: VoiceInfo[];
  value: string | null;
  defaultVoice: string;
  locale: string;
}): VoiceDisplay {
  const chosen = input.value ? input.voices.find((voice) => voice.id === input.value) : undefined;
  if (input.value === null || !chosen) {
    const fallback = input.voices.find((voice) => voice.id === input.defaultVoice);
    return {
      kind: 'default',
      text: `Default${fallback ? ` · ${fallback.name}` : ` (${input.defaultVoice})`}`,
      missing: input.value,
    };
  }
  return {
    kind: 'voice',
    name: chosen.name,
    gender: chosen.gender,
    locale: chosen.locale !== input.locale ? chosen.locale : null,
  };
}

/* --------------------------------------------------------------------- */
/* Choosing                                                              */

export interface VoiceDefaults {
  voice: string;
  locale: string;
}

/** The language in effect: the person's own, else the org's. */
export function effectiveLocale(prefs: VoicePrefs, defaults: VoiceDefaults): string {
  return prefs.locale ?? defaults.locale;
}

/** Every language on offer: the voices', the org's default and the person's own. */
export function localesOnOffer(
  voices: VoiceInfo[] | null,
  prefs: VoicePrefs,
  defaults: VoiceDefaults
): string[] {
  const set = new Set((voices ?? []).map((voice) => voice.locale));
  set.add(defaults.locale);
  if (prefs.locale) set.add(prefs.locale);
  return [...set];
}

/**
 * Choosing a language. The org's default is stored as "none of my own".
 * A voice that cannot speak the new language is dropped with it; a
 * multilingual one stays.
 */
export function chooseLocale(
  prefs: VoicePrefs,
  next: string,
  voices: VoiceInfo[] | null,
  defaults: VoiceDefaults
): VoicePrefs {
  const chosen = prefs.voice
    ? ((voices ?? []).find((voice) => voice.id === prefs.voice) ?? null)
    : null;
  return {
    ...prefs,
    locale: next === defaults.locale ? null : next,
    voice: chosen && voiceSpeaks(chosen, next) ? prefs.voice : null,
  };
}

/**
 * Choosing a voice (null: the org's default). A voice of another language
 * brings its language along, since that is what it will be speaking.
 */
export function chooseVoice(
  prefs: VoicePrefs,
  voice: VoiceInfo | null,
  defaults: VoiceDefaults
): VoicePrefs {
  if (!voice) return { ...prefs, voice: null };
  const locale = effectiveLocale(prefs, defaults);
  const nextLocale = voiceSpeaks(voice, locale) ? locale : voice.locale;
  return {
    ...prefs,
    voice: voice.id,
    locale: nextLocale === defaults.locale ? null : nextLocale,
  };
}

/** The voices the vendor answered with, or none and why. */
export interface VoiceCatalog {
  voices: VoiceInfo[] | null;
  error: string | null;
}

/** What `voiceClient.status()` answered, as the pickers use it. */
export function catalogFrom(result: {
  data: { voices: VoiceInfo[]; voicesError?: string | null } | null;
  error: string | null;
}): VoiceCatalog {
  if (!result.data) return { voices: [], error: result.error };
  return { voices: result.data.voices, error: result.data.voicesError ?? null };
}
