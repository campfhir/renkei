/**
 * The chunker's boundary behavior and the refId suffix scheme the ACL gate
 * and the unique (tenant_id, provider, ref_id) index both depend on.
 */

// chunking.ts → ingest.ts → @renkei/db + kysely (ESM, unloadable under
// jest); the pure functions under test never touch either.
jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));
jest.mock('kysely', () => ({ sql: jest.fn() }));

import { chunkText, chunkRefId } from './chunking';

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
