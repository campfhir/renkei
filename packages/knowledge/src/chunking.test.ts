/**
 * The chunker's boundary behavior and the refId suffix scheme the ACL gate
 * and the unique (tenant_id, provider, ref_id) index both depend on.
 */

// chunking.ts → ingest.ts → @renkei/db + kysely (ESM, unloadable under
// jest); the pure functions under test never touch either.
jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));
jest.mock('kysely', () => ({ sql: jest.fn() }));
// Keyword enrichment resolves the org's default LLM; these tests are about
// chunking and embedding, so the org has none unless a test passes one.
jest.mock('./keywords', () => ({ resolveKeywordExtractor: jest.fn(async () => null) }));

import { ok } from '@campfhir/safe-functions/helpers';
import { chunkText, chunkRefId, ingestObjectChunks } from './chunking';
import type { EmbeddingProvider } from './embeddings';
import type { KeywordExtractor } from './keywords';

const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');

describe('chunkText', () => {
  it('returns nothing for blank input', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n  ')).toEqual([]);
  });

  it('keeps short text as a single chunk, trimmed', () => {
    expect(chunkText('  hello world  ')).toEqual(['hello world']);
  });

  it('splits long text and respects the ceiling', () => {
    const text = Array.from({ length: 100 }, (_, i) => `paragraph ${i} with some words`).join(
      '\n\n'
    );
    const chunks = chunkText(text, { maxChars: 300, overlap: 30 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(300);
      expect(chunk).toBe(chunk.trim());
    }
  });

  it('prefers paragraph boundaries over mid-word cuts', () => {
    const text = `${'a'.repeat(150)}\n\n${'b'.repeat(150)}`;
    const chunks = chunkText(text, { maxChars: 200, overlap: 0 });
    expect(chunks[0]).toBe('a'.repeat(150));
  });

  it('covers all content: every part of the input appears in some chunk', () => {
    const words = Array.from({ length: 200 }, (_, i) => `word${i}`);
    const chunks = chunkText(words.join(' '), { maxChars: 250, overlap: 25 });
    const joined = chunks.join(' ');
    for (const word of words) expect(joined).toContain(word);
  });

  it('makes progress even on unbreakable runs longer than maxChars', () => {
    const chunks = chunkText('x'.repeat(1000), { maxChars: 100, overlap: 10 });
    expect(chunks.length).toBeGreaterThanOrEqual(10);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(100);
  });
});

describe('chunkRefId', () => {
  it('keeps the bare refId for single-chunk objects', () => {
    expect(chunkRefId('user@example.com/msg/abc', 1, 1)).toBe('user@example.com/msg/abc');
  });

  it('zero-pads multi-chunk suffixes', () => {
    expect(chunkRefId('host@x.com/uuid==', 1, 3)).toBe('host@x.com/uuid==#0001');
    expect(chunkRefId('host@x.com/uuid==', 12, 30)).toBe('host@x.com/uuid==#0012');
  });
});

describe('ingestObjectChunks — embedding batches', () => {
  // Content is encrypted at rest, so the upsert path needs a key even
  // against a stub db — without one every ingest is ENCRYPTION_FAILED
  // (which is exactly how CI, with no env, caught this).
  const savedContentKey = process.env.CONTENT_ENCRYPTION_KEY;
  beforeAll(() => {
    process.env.CONTENT_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  });
  afterAll(() => {
    if (savedContentKey === undefined) delete process.env.CONTENT_ENCRYPTION_KEY;
    else process.env.CONTENT_ENCRYPTION_KEY = savedContentKey;
  });

  /** A db stub whose delete and insert chains both succeed silently; inserted rows are kept. */
  let inserted: Record<string, unknown>[] = [];
  function stubDb(): void {
    inserted = [];
    mockGetDatabase.mockReturnValue({
      ok: true,
      val: {
        deleteFrom: () => ({
          where: function where() {
            return { where, execute: async () => [] };
          },
        }),
        insertInto: () => ({
          values: (row: Record<string, unknown>) => {
            inserted.push(row);
            return { onConflict: () => ({ execute: async () => [] }) };
          },
        }),
      },
    });
  }

  function embedderRecording(calls: string[][]): EmbeddingProvider {
    return {
      embed: async (texts) => {
        calls.push([...texts]);
        return ok(texts.map(() => [0.1]));
      },
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    stubDb();
  });

  const object = (content: string) => ({
    provider: 'zoom',
    refId: 'host@x.com/uuid/transcript',
    content,
    metadata: {},
    sourceAt: null,
  });

  it('embeds a multi-chunk object in one batched call, not one per chunk', async () => {
    const calls: string[][] = [];
    const text = Array.from({ length: 40 }, (_, i) => `paragraph ${i} with some words`).join(
      '\n\n'
    );
    const result = await ingestObjectChunks('tenant-1', embedderRecording(calls), object(text), {
      maxChars: 200,
      overlap: 20,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.val.chunks).toBeGreaterThan(1);
    expect(calls).toHaveLength(1);
    if (result.ok) expect(calls[0]).toHaveLength(result.val.chunks);
  });

  it('splits into multiple requests only past the 64-piece batch cap', async () => {
    const calls: string[][] = [];
    const text = Array.from({ length: 80 }, (_, i) => `p${i} ${'x'.repeat(90)}`).join('\n\n');
    const result = await ingestObjectChunks('tenant-1', embedderRecording(calls), object(text), {
      maxChars: 100,
      overlap: 0,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.val.chunks).toBeGreaterThan(64);
    expect(calls).toHaveLength(Math.ceil(result.val.chunks / 64));
    expect(calls[0]).toHaveLength(64);
  });

  it('skips the embed call entirely when a matching vector is precomputed', async () => {
    const calls: string[][] = [];
    const result = await ingestObjectChunks(
      'tenant-1',
      embedderRecording(calls),
      object('short content'),
      { precomputed: { content: 'short content', vector: [0.5, 0.5] } }
    );
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('ignores a precomputed vector whose content does not match what will be stored', async () => {
    const calls: string[][] = [];
    await ingestObjectChunks('tenant-1', embedderRecording(calls), object('short content'), {
      precomputed: { content: 'different content', vector: [0.5] },
    });
    expect(calls).toHaveLength(1);
  });

  describe('keyword enrichment', () => {
    function extractorReturning(keywords: string[], seen: string[][]): KeywordExtractor {
      return {
        extract: async ({ title, content }) => {
          seen.push([title, content]);
          return ok(keywords);
        },
      };
    }

    it('extracts once per object and stores the same list on every chunk', async () => {
      const seen: string[][] = [];
      const text = Array.from({ length: 40 }, (_, i) => `paragraph ${i} with some words`).join(
        '\n\n'
      );
      const result = await ingestObjectChunks(
        'tenant-1',
        embedderRecording([]),
        { ...object(text), metadata: { title: 'Runbook' } },
        { maxChars: 200, overlap: 20, keywords: extractorReturning(['ENG-787', 'printers'], seen) }
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.val.keywords).toBe(2);
      expect(seen).toEqual([['Runbook', text]]);
      expect(inserted.length).toBe(result.val.chunks);
      for (const row of inserted) expect(row.keywords).toEqual(['ENG-787', 'printers']);
    });

    it('stores NULL (not extracted) when there is no extractor, and on failure', async () => {
      await ingestObjectChunks('tenant-1', embedderRecording([]), object('short'), {
        keywords: null,
      });
      expect(inserted[0]?.keywords).toBeNull();

      stubDb();
      const failing: KeywordExtractor = {
        extract: async () => ({ ok: false, err: { type: 'KEYWORDS_FAILED' as const } }),
      };
      const result = await ingestObjectChunks('tenant-1', embedderRecording([]), object('short'), {
        keywords: failing,
      });
      // Enrichment only: the object still indexes.
      expect(result.ok).toBe(true);
      expect(inserted[0]?.keywords).toBeNull();
    });

    it('stores an empty list when extraction ran and found nothing', async () => {
      await ingestObjectChunks('tenant-1', embedderRecording([]), object('short'), {
        keywords: extractorReturning([], []),
      });
      expect(inserted[0]?.keywords).toEqual([]);
    });

    it('does not disturb the precomputed-vector fast path', async () => {
      const calls: string[][] = [];
      await ingestObjectChunks('tenant-1', embedderRecording(calls), object('short content'), {
        precomputed: { content: 'short content', vector: [0.5, 0.5] },
        keywords: extractorReturning(['x'], []),
      });
      expect(calls).toHaveLength(0);
      expect(inserted[0]?.keywords).toEqual(['x']);
    });
  });
});
