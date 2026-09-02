/**
 * Keyword enrichment: the prompt is bounded, the reply parser is tolerant
 * of the ways a model disobeys "strict JSON", and resolution is enrichment
 * only — every way of being unconfigured yields null, never an error.
 */

jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));
jest.mock('kysely', () => ({ sql: jest.fn() }));
jest.mock('@renkei/connector-config', () => ({ readConnectorConfigCached: jest.fn() }));
jest.mock('@renkei/agent-llm', () => ({ resolveAgentLlm: jest.fn() }));
jest.mock('@renkei/crypto', () => ({
  parseEncryptionKey: jest.fn(() => ({ ok: true, val: Buffer.alloc(32) })),
}));

import { ok, err } from '@campfhir/safe-functions/helpers';
import type { LlmProvider, LlmRequest } from '@renkei/agent-llm';
import {
  parseKeywords,
  keywordPrompt,
  createLlmKeywordExtractor,
  resolveKeywordExtractor,
  KEYWORD_INPUT_MAX_CHARS,
  MAX_KEYWORDS,
} from './keywords';

const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');
const { readConnectorConfigCached: mockReadConfig } = jest.requireMock<{
  readConnectorConfigCached: jest.Mock;
}>('@renkei/connector-config');
const { resolveAgentLlm: mockResolveLlm } = jest.requireMock<{ resolveAgentLlm: jest.Mock }>(
  '@renkei/agent-llm'
);

describe('parseKeywords', () => {
  it('reads a JSON array', () => {
    expect(parseKeywords('["ENG-787", "printer outage", "Sam Okafor"]')).toEqual([
      'ENG-787',
      'printer outage',
      'Sam Okafor',
    ]);
  });

  it('finds the array inside fences or a preamble', () => {
    expect(parseKeywords('Here you go:\n```json\n["a", "b"]\n```')).toEqual(['a', 'b']);
  });

  it('falls back to one-per-line, stripping bullets and quotes', () => {
    expect(parseKeywords('- "vendor contract"\n2. renewal\n* Acme')).toEqual([
      'vendor contract',
      'renewal',
      'Acme',
    ]);
  });

  it('falls back to a comma list on a single line', () => {
    expect(parseKeywords('alpha, beta, gamma')).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('dedupes case-insensitively, drops sentences and non-strings, caps the count', () => {
    const many = JSON.stringify([
      'Acme',
      'acme',
      42,
      'x'.repeat(61),
      '',
      ...Array.from({ length: 30 }, (_, i) => `term ${i}`),
    ]);
    const parsed = parseKeywords(many);
    expect(parsed[0]).toBe('Acme');
    expect(parsed).not.toContain('acme');
    expect(parsed.every((keyword) => keyword.length <= 60)).toBe(true);
    expect(parsed).toHaveLength(MAX_KEYWORDS);
  });

  it('yields nothing for a reply with no list in it', () => {
    expect(parseKeywords('')).toEqual([]);
    expect(parseKeywords('   ')).toEqual([]);
  });
});

describe('keywordPrompt', () => {
  it('caps the document it shows the model', () => {
    const prompt = keywordPrompt('T', 'x'.repeat(KEYWORD_INPUT_MAX_CHARS * 2));
    expect(prompt.length).toBeLessThan(KEYWORD_INPUT_MAX_CHARS + 1_000);
    expect(prompt).toContain('[…truncated]');
    expect(prompt).toContain('Title: T');
  });
});

describe('createLlmKeywordExtractor', () => {
  function providerAnswering(text: string, requests: LlmRequest[]): LlmProvider {
    return {
      complete: async (request) => {
        requests.push(request);
        return ok({
          content: [{ type: 'text' as const, text }],
          stopReason: 'end_turn' as const,
          usage: { inputTokens: 1, outputTokens: 1 },
        });
      },
    };
  }

  it('asks once, at temperature 0, with no tools, and parses the reply', async () => {
    const requests: LlmRequest[] = [];
    const extractor = createLlmKeywordExtractor(providerAnswering('["a","b"]', requests));
    const result = await extractor.extract({ title: 'Doc', content: 'body' });
    expect(result).toEqual(ok(['a', 'b']));
    expect(requests).toHaveLength(1);
    expect(requests[0]?.temperature).toBe(0);
    expect(requests[0]?.tools).toEqual([]);
    expect(requests[0]?.timeoutMs).toBeDefined();
  });

  it('skips the call for blank content', async () => {
    const requests: LlmRequest[] = [];
    const extractor = createLlmKeywordExtractor(providerAnswering('["a"]', requests));
    expect(await extractor.extract({ title: 'Doc', content: '  ' })).toEqual(ok([]));
    expect(requests).toHaveLength(0);
  });

  it('reports a provider failure as KEYWORDS_FAILED', async () => {
    const extractor = createLlmKeywordExtractor({
      complete: async () => err('timeout' as const),
    });
    const result = await extractor.extract({ title: '', content: 'body' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.type).toBe('KEYWORDS_FAILED');
  });
});

describe('resolveKeywordExtractor', () => {
  const savedKey = process.env.TOKEN_ENCRYPTION_KEY;
  beforeAll(() => {
    process.env.TOKEN_ENCRYPTION_KEY = 'k';
  });
  afterAll(() => {
    if (savedKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = savedKey;
  });
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetDatabase.mockReturnValue({ ok: true, val: {} });
    mockReadConfig.mockResolvedValue({
      ok: true,
      val: { enabled: true, settings: { baseUrl: 'u', model: 'm' }, secrets: { apiKey: 'k' } },
    });
    mockResolveLlm.mockResolvedValue(ok({ provider: { complete: jest.fn() } }));
  });

  it('resolves the org default model when the knowledge layer is on', async () => {
    expect(await resolveKeywordExtractor('tenant-1')).not.toBeNull();
    expect(mockResolveLlm).toHaveBeenCalledWith({}, 'tenant-1', null);
  });

  it('is null when the switch is off, and never asks for a model', async () => {
    mockReadConfig.mockResolvedValue({
      ok: true,
      val: { enabled: true, settings: { keywordEnrichment: false }, secrets: {} },
    });
    expect(await resolveKeywordExtractor('tenant-1')).toBeNull();
    expect(mockResolveLlm).not.toHaveBeenCalled();
  });

  it('is null when the knowledge layer itself is off', async () => {
    mockReadConfig.mockResolvedValue({ ok: true, val: null });
    expect(await resolveKeywordExtractor('tenant-1')).toBeNull();
    mockReadConfig.mockResolvedValue({
      ok: true,
      val: { enabled: false, settings: {}, secrets: {} },
    });
    expect(await resolveKeywordExtractor('tenant-1')).toBeNull();
  });

  it('is null when the org has no default model — never an error', async () => {
    mockResolveLlm.mockResolvedValue(err('NO_MODEL' as const));
    expect(await resolveKeywordExtractor('tenant-1')).toBeNull();
  });
});
