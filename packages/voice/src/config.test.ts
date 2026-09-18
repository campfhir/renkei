/**
 * The stored row → typed config step. A half-filled form must read as "not
 * configured" rather than as a config that fails on first use, and the
 * normalisers must accept what admins actually paste (a region in caps, an
 * endpoint with a trailing slash, a locale with an underscore).
 */

import {
  createVoiceProvider,
  normalizeEndpoint,
  normalizeLocale,
  normalizeRegion,
  parseVoiceConfig,
  parseVoiceProviderKind,
} from './config';

describe('parseVoiceConfig', () => {
  it('needs a region or endpoint, and a key', () => {
    expect(parseVoiceConfig({ region: 'eastus' }, {})).toBeNull();
    expect(parseVoiceConfig({}, { apiKey: 'k' })).toBeNull();
    expect(parseVoiceConfig({ region: 'eastus' }, { apiKey: 'k' })).toEqual({
      provider: 'azure-speech',
      region: 'eastus',
      endpoint: null,
      apiKey: 'k',
      defaultVoice: 'en-US-AvaMultilingualNeural',
      defaultLocale: 'en-US',
    });
  });

  it('accepts a custom endpoint in place of a region', () => {
    const config = parseVoiceConfig(
      { endpoint: 'https://speech.example.com/', defaultVoice: 'en-GB-SoniaNeural' },
      { apiKey: 'k' }
    );
    expect(config?.endpoint).toBe('https://speech.example.com');
    expect(config?.region).toBe('');
    expect(config?.defaultVoice).toBe('en-GB-SoniaNeural');
  });

  it('falls back to Azure for an unknown provider rather than failing', () => {
    expect(
      parseVoiceConfig({ provider: 'someday', region: 'eastus' }, { apiKey: 'k' })?.provider
    ).toBe('azure-speech');
    expect(parseVoiceProviderKind('azure-speech')).toBe('azure-speech');
    expect(parseVoiceProviderKind('elevenlabs')).toBeNull();
  });
});

describe('normalisers', () => {
  it('lowercases a region and rejects anything that is not a bare name', () => {
    expect(normalizeRegion(' EastUS ')).toBe('eastus');
    expect(normalizeRegion('east-us')).toBeNull();
    expect(normalizeRegion('https://eastus')).toBeNull();
    expect(normalizeRegion('')).toBeNull();
  });

  it('keeps only https endpoints without a query, minus the trailing slash', () => {
    expect(normalizeEndpoint('https://a.b.c/')).toBe('https://a.b.c');
    expect(normalizeEndpoint('http://a.b.c')).toBeNull();
    expect(normalizeEndpoint('https://a.b.c/?x=1')).toBeNull();
    expect(normalizeEndpoint('not a url')).toBeNull();
    expect(normalizeEndpoint('')).toBeNull();
  });

  it('canonicalises a BCP-47 tag', () => {
    expect(normalizeLocale('en_us')).toBe('en-US');
    expect(normalizeLocale('PT-br')).toBe('pt-BR');
    expect(normalizeLocale('english')).toBeNull();
    expect(normalizeLocale(null)).toBeNull();
  });
});

describe('createVoiceProvider', () => {
  it('builds the Azure provider for an Azure config', () => {
    const provider = createVoiceProvider({
      provider: 'azure-speech',
      region: 'eastus',
      endpoint: null,
      apiKey: 'k',
      defaultVoice: 'v',
      defaultLocale: 'en-US',
    });
    expect(provider.kind).toBe('azure-speech');
  });
});
