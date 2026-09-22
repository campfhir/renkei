/**
 * The vendor's voice catalog as a picker wants it: languages and their
 * regions named the way the browser names them, voices grouped under the
 * language they speak with the person's own language first, and one
 * search across everything a person might type — a voice's name, a
 * language in English or in itself ("Deutsch"), a country, a tag, a word
 * from the vendor's description ("warm", "customer service").
 */

import type { VoiceInfo } from '@renkei/voice';

/** `en` of `en-US`. */
export function languageOf(tag: string): string {
  return tag.split('-')[0].toLowerCase();
}

/** A locale tag as a person reads it, using the browser's own names: "British English". */
export function localeLabel(locale: string): string {
  try {
    const names = new Intl.DisplayNames(undefined, { type: 'language' });
    return names.of(locale) ?? locale;
  } catch {
    return locale;
  }
}

/** The language alone: "English" for `en-GB`. */
export function languageLabel(locale: string): string {
  try {
    const names = new Intl.DisplayNames(undefined, { type: 'language' });
    return names.of(languageOf(locale)) ?? locale;
  } catch {
    return locale;
  }
}

/** The region alone: "United Kingdom" for `en-GB`; null for a tag without one. */
export function regionLabel(locale: string): string | null {
  const region = locale.split('-')[1];
  if (!region) return null;
  try {
    const names = new Intl.DisplayNames(undefined, { type: 'region' });
    return names.of(region.toUpperCase()) ?? region;
  } catch {
    return region;
  }
}

/** The locale named in its own language — "Deutsch (Deutschland)" — for search; null when the browser cannot. */
export function nativeLocaleLabel(locale: string): string | null {
  try {
    const names = new Intl.DisplayNames(locale, { type: 'language' });
    return names.of(locale) ?? null;
  } catch {
    return null;
  }
}

/** Every word of the query somewhere in the text, case-insensitively. */
export function matchesWords(haystack: string, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = haystack.toLowerCase();
  return words.every((word) => text.includes(word));
}

/** What a search over locales looks through, for one tag. */
export function localeSearchText(locale: string): string {
  return [
    locale,
    localeLabel(locale),
    languageLabel(locale),
    regionLabel(locale) ?? '',
    nativeLocaleLabel(locale) ?? '',
  ].join(' ');
}

export function localeMatches(locale: string, query: string): boolean {
  return matchesWords(localeSearchText(locale), query);
}

/** What a search over voices looks through, for one voice. */
export function voiceSearchText(voice: VoiceInfo): string {
  return [
    voice.name,
    voice.id,
    voice.gender ?? '',
    voice.description ?? '',
    voice.multilingual ? 'multilingual' : '',
    localeSearchText(voice.locale),
  ].join(' ');
}

export function voiceMatches(voice: VoiceInfo, query: string): boolean {
  return matchesWords(voiceSearchText(voice), query);
}

export interface LanguageGroup {
  /** The language subtag, `en`. */
  language: string;
  label: string;
  /** Its regions' tags, `en-AU`, `en-GB`, `en-US`, by the regions' names. */
  locales: string[];
}

/**
 * Locales under their language, languages by name; with `first`, that
 * language leads and that locale leads its language, so a person's own
 * language is at the top of the list rather than under E.
 */
export function groupLocales(tags: string[], first: string | null = null): LanguageGroup[] {
  const byLanguage = new Map<string, Set<string>>();
  for (const tag of tags) {
    const language = languageOf(tag);
    const set = byLanguage.get(language) ?? new Set<string>();
    set.add(tag);
    byLanguage.set(language, set);
  }
  const groups: LanguageGroup[] = [...byLanguage.entries()].map(([language, set]) => ({
    language,
    label: languageLabel(`${language}-`),
    locales: [...set].sort((a, b) =>
      (regionLabel(a) ?? localeLabel(a)).localeCompare(regionLabel(b) ?? localeLabel(b))
    ),
  }));
  groups.sort((a, b) => a.label.localeCompare(b.label));
  if (first) {
    const lead = languageOf(first);
    const index = groups.findIndex((group) => group.language === lead);
    if (index > 0) groups.unshift(...groups.splice(index, 1));
    const group = groups[0];
    if (group && group.language === lead && group.locales.includes(first)) {
      group.locales = [first, ...group.locales.filter((tag) => tag !== first)];
    }
  }
  return groups;
}

export interface VoiceGroup {
  locale: string;
  /** "English · United States (en-US)". */
  label: string;
  voices: VoiceInfo[];
}

/** The heading a group of voices sits under. */
export function voiceGroupLabel(locale: string): string {
  const region = regionLabel(locale);
  return region
    ? `${languageLabel(locale)} · ${region} (${locale})`
    : `${localeLabel(locale)} (${locale})`;
}

/**
 * Voices under their locale: the chosen locale first, then the other
 * regions of its language, then every other language by name; voices by
 * name within a group.
 */
export function groupVoices(voices: VoiceInfo[], chosenLocale: string): VoiceGroup[] {
  const byLocale = new Map<string, VoiceInfo[]>();
  for (const voice of voices) {
    const list = byLocale.get(voice.locale) ?? [];
    list.push(voice);
    byLocale.set(voice.locale, list);
  }
  const language = languageOf(chosenLocale);
  const rank = (locale: string) =>
    locale === chosenLocale ? 0 : languageOf(locale) === language ? 1 : 2;
  return [...byLocale.entries()]
    .map(([locale, list]) => ({
      locale,
      label: voiceGroupLabel(locale),
      voices: [...list].sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => rank(a.locale) - rank(b.locale) || a.label.localeCompare(b.label));
}

/** Whether a voice can read `locale`: its own, or any for a multilingual one. */
export function voiceSpeaks(voice: VoiceInfo, locale: string): boolean {
  return voice.locale === locale || voice.multilingual;
}

/** The language a voice is tried out in: the chosen one when it speaks it, else its own. */
export function previewLocale(voice: VoiceInfo, chosenLocale: string): string {
  return voiceSpeaks(voice, chosenLocale) ? chosenLocale : voice.locale;
}

/**
 * The voice to say something in `locale` with: the person's own when it
 * speaks that language, else the org's default when it does, else a
 * voice of that very locale (the same gender as theirs, where there is
 * one), else a multilingual voice of the language, else any multilingual
 * voice — and, when nothing speaks it, the person's own after all, since
 * a wrong accent beats silence. Null means the vendor's default, as a
 * request without a voice always has. What lets a reply heard in
 * Japanese be read in Japanese by someone whose voice is British.
 */
export function voiceForLocale(
  voices: VoiceInfo[],
  preferred: string | null,
  defaultVoice: string,
  locale: string
): string | null {
  const own = preferred ? voices.find((voice) => voice.id === preferred) : undefined;
  if (preferred && (!own || voiceSpeaks(own, locale))) return preferred;
  const fallback = voices.find((voice) => voice.id === defaultVoice);
  if (fallback && voiceSpeaks(fallback, locale)) return null;
  const gender = own?.gender ?? fallback?.gender ?? null;
  const byName = (a: VoiceInfo, b: VoiceInfo) => a.name.localeCompare(b.name);
  const natives = voices.filter((voice) => voice.locale === locale).sort(byName);
  const language = languageOf(locale);
  const candidates = [
    natives.filter((voice) => gender !== null && voice.gender === gender),
    natives,
    voices.filter((voice) => voice.multilingual && languageOf(voice.locale) === language),
    voices.filter((voice) => voice.multilingual),
  ];
  for (const list of candidates) {
    const found = list.sort(byName)[0];
    if (found) return found.id;
  }
  return preferred;
}
