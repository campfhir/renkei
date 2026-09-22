import type { VoiceInfo } from '@renkei/voice';
import {
  groupLocales,
  groupVoices,
  localeMatches,
  matchesWords,
  previewLocale,
  voiceForLocale,
  voiceGroupLabel,
  voiceMatches,
  voiceSpeaks,
} from './catalog';

const voice = (id: string, locale: string, extra: Partial<VoiceInfo> = {}): VoiceInfo => ({
  id,
  name: id.split('-')[2].replace(/Neural$/, ''),
  locale,
  gender: 'female',
  description: null,
  multilingual: false,
  ...extra,
});

const ava = voice('en-US-AvaMultilingualNeural', 'en-US', {
  name: 'Ava Multilingual',
  multilingual: true,
  description: 'Friendly, warm · conversation, copilot',
});
const sonia = voice('en-GB-SoniaNeural', 'en-GB');
const katja = voice('de-DE-KatjaNeural', 'de-DE');
const xiaoxiao = voice('zh-CN-XiaoxiaoNeural', 'zh-CN', {
  name: 'Xiaoxiao (晓晓)',
  description: 'Lively, warm · news, novel',
});

describe('matchesWords', () => {
  it('wants every word somewhere, in any order and case', () => {
    expect(matchesWords('Ava Multilingual en-US Friendly', 'friendly ava')).toBe(true);
    expect(matchesWords('Ava Multilingual en-US Friendly', 'ava grumpy')).toBe(false);
    expect(matchesWords('anything', '   ')).toBe(true);
  });
});

describe('localeMatches', () => {
  it('finds a locale by tag, language, region or its own name', () => {
    expect(localeMatches('de-DE', 'german')).toBe(true);
    expect(localeMatches('de-DE', 'deutsch')).toBe(true);
    expect(localeMatches('en-GB', 'united kingdom')).toBe(true);
    expect(localeMatches('en-GB', 'en-gb')).toBe(true);
    expect(localeMatches('en-GB', 'japan')).toBe(false);
  });
});

describe('voiceMatches', () => {
  it('finds a voice by name, description, language or country', () => {
    expect(voiceMatches(ava, 'warm')).toBe(true);
    expect(voiceMatches(ava, 'multilingual')).toBe(true);
    expect(voiceMatches(ava, 'united states')).toBe(true);
    expect(voiceMatches(xiaoxiao, 'chinese novel')).toBe(true);
    expect(voiceMatches(xiaoxiao, '晓晓')).toBe(true);
    expect(voiceMatches(sonia, 'warm')).toBe(false);
  });
});

describe('groupLocales', () => {
  it('puts regions under their language, languages by name', () => {
    const groups = groupLocales(['en-US', 'de-DE', 'en-GB', 'ja-JP', 'en-AU']);
    // English, German, Japanese: by the name a person reads, not the code.
    expect(groups.map((group) => group.language)).toEqual(['en', 'de', 'ja']);
    expect(groups.find((group) => group.language === 'en')?.locales).toEqual([
      'en-AU',
      'en-GB',
      'en-US',
    ]);
  });

  it("leads with the person's own language and region", () => {
    const groups = groupLocales(['en-US', 'de-DE', 'en-GB', 'ja-JP'], 'ja-JP');
    expect(groups[0].language).toBe('ja');
    const led = groupLocales(['en-US', 'de-DE', 'en-GB', 'ja-JP'], 'en-GB');
    expect(led[0].language).toBe('en');
    expect(led[0].locales).toEqual(['en-GB', 'en-US']);
  });
});

describe('groupVoices', () => {
  it('leads with the chosen locale, then its language, then the rest by name', () => {
    const groups = groupVoices([katja, xiaoxiao, ava, sonia], 'en-GB');
    expect(groups.map((group) => group.locale)).toEqual(['en-GB', 'en-US', 'zh-CN', 'de-DE']);
  });

  it('names a group by language and region', () => {
    expect(voiceGroupLabel('en-US')).toBe('English · United States (en-US)');
  });
});

describe('voiceForLocale', () => {
  const ryan = voice('en-GB-RyanNeural', 'en-GB', { gender: 'male' });
  const nanami = voice('ja-JP-NanamiNeural', 'ja-JP');
  const keita = voice('ja-JP-KeitaNeural', 'ja-JP', { gender: 'male' });
  const all = [sonia, ryan, ava, katja, xiaoxiao, nanami, keita];

  it("keeps the person's voice when it speaks the language", () => {
    expect(voiceForLocale(all, sonia.id, ava.id, 'en-GB')).toBe(sonia.id);
    expect(voiceForLocale(all, ava.id, sonia.id, 'ja-JP')).toBe(ava.id);
    // A voice the catalog no longer lists is trusted as it is.
    expect(voiceForLocale(all, 'en-US-GoneNeural', ava.id, 'ja-JP')).toBe('en-US-GoneNeural');
  });

  it("falls to the org's default when that speaks it", () => {
    expect(voiceForLocale(all, sonia.id, ava.id, 'ja-JP')).toBeNull();
    expect(voiceForLocale(all, null, ava.id, 'de-DE')).toBeNull();
  });

  it('finds a native voice of the language, the same gender first', () => {
    expect(voiceForLocale(all, ryan.id, sonia.id, 'ja-JP')).toBe(keita.id);
    expect(voiceForLocale(all, sonia.id, ryan.id, 'ja-JP')).toBe(nanami.id);
    expect(voiceForLocale(all, null, sonia.id, 'de-DE')).toBe(katja.id);
  });

  it('takes a multilingual voice when the language has no native one', () => {
    expect(voiceForLocale([sonia, ryan, ava, katja], sonia.id, ryan.id, 'fr-FR')).toBe(ava.id);
  });

  it("keeps the person's own when nothing speaks the language", () => {
    expect(voiceForLocale([sonia, ryan], sonia.id, ryan.id, 'fr-FR')).toBe(sonia.id);
    expect(voiceForLocale([sonia, ryan], null, ryan.id, 'fr-FR')).toBeNull();
  });
});

describe('voiceSpeaks and previewLocale', () => {
  it('lets a multilingual voice keep the chosen language, others their own', () => {
    expect(voiceSpeaks(ava, 'zh-CN')).toBe(true);
    expect(voiceSpeaks(sonia, 'zh-CN')).toBe(false);
    expect(previewLocale(ava, 'zh-CN')).toBe('zh-CN');
    expect(previewLocale(sonia, 'zh-CN')).toBe('en-GB');
    expect(previewLocale(sonia, 'en-GB')).toBe('en-GB');
  });
});
