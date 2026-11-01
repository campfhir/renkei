/**
 * The language and voice pickers (voice-picker.model.ts), as a person
 * choosing a voice would describe them — on the speaker menu and on
 * Preferences alike. The catalog is the browser specs' fixture
 * (e2e/support/voice.ts): eleven voices in seven languages. The browser
 * spec (voice-pickers.spec.ts) keeps how the pickers look open and
 * searched at both sizes, a sample playing, and that Escape closes only
 * the picker inside the menu.
 */

import type { VoicePrefs } from '@renkei/user-prefs/prefs';
import type { VoiceInfo } from '@renkei/voice';
import { groupLocales, localeMatches } from '@/lib/voice/catalog';
import {
  DEFAULT_KEY,
  catalogFrom,
  chooseLocale,
  chooseVoice,
  comboboxReducer,
  effectiveLocale,
  flatItems,
  initialCombobox,
  localesOnOffer,
  rowKey,
  selectedIndex,
  shownGroups,
  voiceDisplay,
  voiceRowGroups,
  voiceRowMatches,
  type ComboboxAction,
  type Group,
} from './voice-picker.model';

const v = (
  id: string,
  name: string,
  description: string | null = null,
  more: Partial<VoiceInfo> = {}
): VoiceInfo => ({
  id,
  name,
  locale: id.split('-').slice(0, 2).join('-'),
  gender: 'female',
  description,
  multilingual: false,
  ...more,
});

const VOICES: VoiceInfo[] = [
  v(
    'en-US-AvaMultilingualNeural',
    'Ava Multilingual',
    'Friendly, positive · conversation, copilot',
    { multilingual: true }
  ),
  v(
    'en-US-AndrewMultilingualNeural',
    'Andrew Multilingual',
    'Warm, confident · conversation, copilot',
    { multilingual: true, gender: 'male' }
  ),
  v('en-US-EmmaNeural', 'Emma', 'Cheerful, clear · conversation, customer service'),
  v('en-GB-SoniaNeural', 'Sonia', 'Calm, pleasant · narration, news'),
  v('en-GB-RyanNeural', 'Ryan', null, { gender: 'male' }),
  v('en-AU-NatashaNeural', 'Natasha'),
  v('de-DE-KatjaNeural', 'Katja', 'Friendly · conversation'),
  v('fr-FR-DeniseNeural', 'Denise'),
  v('es-ES-ElviraNeural', 'Elvira'),
  v('ja-JP-NanamiNeural', 'Nanami (七海)', 'Warm, gentle · conversation, narration'),
  v('zh-CN-XiaoxiaoNeural', 'Xiaoxiao (晓晓)', 'Lively, warm · news, novel'),
];
const byId = (id: string) => VOICES.find((voice) => voice.id === id) ?? null;

const DEFAULTS = { voice: 'en-US-AvaMultilingualNeural', locale: 'en-US' };
const SONIA: VoicePrefs = {
  voice: 'en-GB-SoniaNeural',
  rate: 1.25,
  autoPlay: false,
  locale: 'en-GB',
  detectLanguage: true,
  pushToTalk: false,
  accent: 'rainbow',
  userAccent: 'emerald',
};

const rows = (locale = 'en-GB') => voiceRowGroups(VOICES, locale, DEFAULTS.voice);
const search = (query: string, locale = 'en-GB') =>
  flatItems(shownGroups(rows(locale), voiceRowMatches, query));
const names = (items: ReturnType<typeof search>) =>
  items.map((row) => (row.kind === 'default' ? 'Default' : row.voice.name));

describe('the voice list', () => {
  it('leads with the organization default, then the chosen language, then the rest of it, then others', () => {
    const groups = rows();
    expect(groups.map((group) => group.label).slice(0, 4)).toEqual([
      'Organization default',
      'English · United Kingdom (en-GB)',
      'English · Australia (en-AU)',
      'English · United States (en-US)',
    ]);
    const first = groups[0].items[0];
    expect(first.kind === 'default' && first.voice?.name).toBe('Ava Multilingual');
  });

  it('finds voices by a word of their description, in every language', () => {
    expect(names(search('warm'))).toEqual([
      'Andrew Multilingual',
      'Xiaoxiao (晓晓)',
      'Nanami (七海)',
    ]);
  });

  it('finds a country’s voices', () => {
    expect(names(search('japan'))).toEqual(['Nanami (七海)']);
  });

  it('shows the default row with no search, and finds it only by the voice it stands for', () => {
    expect(names(search('')).at(0)).toBe('Default');
    expect(names(search('friendly'))).toEqual(['Default', 'Ava Multilingual', 'Katja']);
    expect(names(search('sonia'))).toEqual(['Sonia']);
  });

  it('drops the groups a search empties', () => {
    const groups = shownGroups(rows(), voiceRowMatches, 'japan');
    expect(groups.map((group) => group.key)).toEqual(['ja-JP']);
    expect(shownGroups(rows(), voiceRowMatches, 'klingon')).toEqual([]);
  });

  it('keys the default row apart from every voice', () => {
    expect(rowKey(rows()[0].items[0])).toBe(DEFAULT_KEY);
  });
});

describe('what the closed voice picker shows', () => {
  const display = (value: string | null, locale = 'en-GB', voices = VOICES) =>
    voiceDisplay({ voices, value, defaultVoice: DEFAULTS.voice, locale });

  it('the chosen voice and its gender', () => {
    expect(display('en-GB-SoniaNeural')).toEqual({
      kind: 'voice',
      name: 'Sonia',
      gender: 'female',
      locale: null,
    });
  });

  it('the voice’s own language when it is not the chosen one', () => {
    expect(display('en-US-AvaMultilingualNeural', 'fr-FR')).toMatchObject({ locale: 'en-US' });
  });

  it('the default by the voice it stands for, or by its id when the vendor does not list it', () => {
    expect(display(null)).toEqual({
      kind: 'default',
      text: 'Default · Ava Multilingual',
      missing: null,
    });
    expect(display(null, 'en-GB', [])).toEqual({
      kind: 'default',
      text: 'Default (en-US-AvaMultilingualNeural)',
      missing: null,
    });
  });

  it('a chosen voice the vendor no longer offers is named, and the default plays meanwhile', () => {
    expect(display('en-GB-LibbyNeural')).toEqual({
      kind: 'default',
      text: 'Default · Ava Multilingual',
      missing: 'en-GB-LibbyNeural',
    });
  });
});

describe('the language list', () => {
  const locales = localesOnOffer(VOICES, SONIA, DEFAULTS);

  it('offers every voice’s language, the org’s and the person’s own', () => {
    expect(new Set(locales)).toEqual(
      new Set(['en-US', 'en-GB', 'en-AU', 'de-DE', 'fr-FR', 'es-ES', 'ja-JP', 'zh-CN'])
    );
    expect(localesOnOffer(null, { ...SONIA, locale: 'cy-GB' }, DEFAULTS).sort()).toEqual([
      'cy-GB',
      'en-US',
    ]);
  });

  it('a chosen language leads the list; a language is found by its own name', () => {
    expect(groupLocales(locales, 'zh-CN')[0].label).toBe('Chinese');
    const found = shownGroups(
      groupLocales(locales, 'zh-CN').map((g) => ({
        key: g.language,
        label: g.label,
        items: g.locales,
      })),
      localeMatches,
      'deutsch'
    );
    expect(flatItems(found)).toEqual(['de-DE']);
  });

  it('the language in effect is the person’s own, else the org’s', () => {
    expect(effectiveLocale(SONIA, DEFAULTS)).toBe('en-GB');
    expect(effectiveLocale({ ...SONIA, locale: null }, DEFAULTS)).toBe('en-US');
  });
});

describe('choosing', () => {
  it('a voice of another language brings its language along', () => {
    expect(chooseVoice(SONIA, byId('zh-CN-XiaoxiaoNeural'), DEFAULTS)).toMatchObject({
      voice: 'zh-CN-XiaoxiaoNeural',
      locale: 'zh-CN',
    });
  });

  it('a multilingual voice keeps the chosen language', () => {
    expect(chooseVoice(SONIA, byId('en-US-AndrewMultilingualNeural'), DEFAULTS)).toMatchObject({
      voice: 'en-US-AndrewMultilingualNeural',
      locale: 'en-GB',
    });
  });

  it('a voice of the org’s language stores the language as the default, not a choice', () => {
    expect(chooseVoice(SONIA, byId('en-US-EmmaNeural'), DEFAULTS).locale).toBeNull();
  });

  it('choosing the default row forgets the voice and keeps the language', () => {
    expect(chooseVoice(SONIA, null, DEFAULTS)).toMatchObject({ voice: null, locale: 'en-GB' });
  });

  it('a language the voice cannot speak drops the voice; a multilingual one stays', () => {
    expect(chooseLocale(SONIA, 'de-DE', VOICES, DEFAULTS)).toMatchObject({
      voice: null,
      locale: 'de-DE',
    });
    const ava = { ...SONIA, voice: 'en-US-AvaMultilingualNeural' };
    expect(chooseLocale(ava, 'de-DE', VOICES, DEFAULTS).voice).toBe('en-US-AvaMultilingualNeural');
  });

  it('choosing the org’s language stores it as the default', () => {
    expect(chooseLocale(SONIA, 'en-US', VOICES, DEFAULTS).locale).toBeNull();
  });

  it('keeps everything else as it was', () => {
    const next = chooseVoice(SONIA, byId('de-DE-KatjaNeural'), DEFAULTS);
    expect(next).toMatchObject({ rate: 1.25, detectLanguage: true, accent: 'rainbow' });
  });
});

describe('the combobox', () => {
  const groups: Group<string>[] = [
    { key: 'a', label: 'A', items: ['a1', 'a2'] },
    { key: 'b', label: 'B', items: ['b1'] },
  ];
  const run = (actions: ComboboxAction[]) => actions.reduce(comboboxReducer, initialCombobox);

  it('opens on the current choice, with an empty search', () => {
    const index = selectedIndex(groups, (item) => item, 'b1');
    expect(index).toBe(2);
    expect(
      run([
        { type: 'search', query: 'x' },
        { type: 'open', selectedIndex: index },
      ])
    ).toEqual({
      open: true,
      query: '',
      active: 2,
    });
  });

  it('opens on the first row when the choice is not listed', () => {
    expect(selectedIndex(groups, (item) => item, 'zz')).toBe(-1);
    expect(run([{ type: 'open', selectedIndex: -1 }]).active).toBe(0);
  });

  it('typing puts the first match under Enter', () => {
    expect(
      run([
        { type: 'open', selectedIndex: 2 },
        { type: 'search', query: 'a' },
      ]).active
    ).toBe(0);
  });

  it('the arrows walk the rows shown and wrap at either end', () => {
    const open = run([{ type: 'open', selectedIndex: 0 }]);
    const up = comboboxReducer(open, { type: 'move', by: -1, count: 3 });
    expect(up.active).toBe(2);
    expect(comboboxReducer(up, { type: 'move', by: 1, count: 3 }).active).toBe(0);
    expect(comboboxReducer(open, { type: 'move', by: 1, count: 0 })).toBe(open);
  });

  it('the pointer moves the highlight; Escape or a choice closes it', () => {
    const open = run([
      { type: 'open', selectedIndex: 0 },
      { type: 'hover', index: 1 },
    ]);
    expect(open.active).toBe(1);
    expect(comboboxReducer(open, { type: 'close' }).open).toBe(false);
    expect(comboboxReducer(initialCombobox, { type: 'close' })).toBe(initialCombobox);
  });
});

describe('the vendor’s catalog', () => {
  it('lists the voices, with the vendor’s complaint when it had one', () => {
    expect(
      catalogFrom({ data: { voices: VOICES, voicesError: 'Partial list' }, error: null })
    ).toEqual({
      voices: VOICES,
      error: 'Partial list',
    });
  });

  it('an unreachable service is no voices, and why', () => {
    expect(catalogFrom({ data: null, error: 'Could not reach the server' })).toEqual({
      voices: [],
      error: 'Could not reach the server',
    });
  });
});
