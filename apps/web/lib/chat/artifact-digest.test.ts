/**
 * The digest the model hands back, made storable: a summary is required
 * and bounded, keywords are distinct and bounded, and junk in either is
 * dropped rather than failing the whole answer. The prompt names the
 * file and marks a text it had to cut.
 */

import {
  DIGEST_INPUT_CHARS,
  KEYWORDS_MAX,
  KEYWORD_MAX_CHARS,
  SUMMARY_MAX_CHARS,
  digestPrompt,
  isDigestStatus,
  parseDigest,
} from './artifact-digest';

describe('parseDigest', () => {
  it('keeps a summary and distinct keywords, folding whitespace', () => {
    const digest = parseDigest({
      summary: '  A vendor SDK  manual.\n\nRetries are exponential. ',
      keywords: ['SDK', 'retries', ' sdk ', 'Retries', 'jitter', '', '  ', '—'],
    });
    expect(digest).toEqual({
      summary: 'A vendor SDK manual. Retries are exponential.',
      keywords: ['SDK', 'retries', 'jitter'],
    });
  });

  it('needs a summary; keywords may be missing or malformed', () => {
    expect(parseDigest({ summary: '', keywords: ['a'] })).toBeNull();
    expect(parseDigest({ keywords: ['a'] })).toBeNull();
    expect(parseDigest(null)).toBeNull();
    expect(parseDigest('text')).toBeNull();
    expect(parseDigest({ summary: 'Only a summary.' })).toEqual({
      summary: 'Only a summary.',
      keywords: [],
    });
    expect(parseDigest({ summary: 'S', keywords: 'not a list' })?.keywords).toEqual([]);
    expect(parseDigest({ summary: 'S', keywords: [1, null, 'one'] })?.keywords).toEqual(['one']);
  });

  it('bounds the summary, each keyword and the number of keywords', () => {
    const digest = parseDigest({
      summary: 'x'.repeat(SUMMARY_MAX_CHARS + 50),
      keywords: Array.from({ length: KEYWORDS_MAX + 10 }, (_, i) => `term-${i}`).concat([
        'y'.repeat(KEYWORD_MAX_CHARS + 20),
      ]),
    });
    expect(digest?.summary).toHaveLength(SUMMARY_MAX_CHARS);
    expect(digest?.keywords).toHaveLength(KEYWORDS_MAX);
    const long = parseDigest({ summary: 'S', keywords: ['y'.repeat(KEYWORD_MAX_CHARS + 20)] });
    expect(long?.keywords[0]).toHaveLength(KEYWORD_MAX_CHARS);
  });
});

describe('digestPrompt', () => {
  it('names the file and hands over the head of its text', () => {
    const prompt = digestPrompt(
      { filename: 'guide.md', contentType: 'text/markdown' },
      '# Guide\n\nRound half to even.'
    );
    expect(prompt).toBe(
      '<file name="guide.md" type="text/markdown">\n# Guide\n\nRound half to even.\n</file>'
    );
  });

  it('cuts a long text and says so', () => {
    const prompt = digestPrompt(
      { filename: 'big.txt', contentType: 'text/plain' },
      'a'.repeat(DIGEST_INPUT_CHARS + 1)
    );
    expect(prompt.startsWith('<file name="big.txt" type="text/plain" truncated="true">')).toBe(
      true
    );
    expect(prompt.length).toBeLessThan(DIGEST_INPUT_CHARS + 100);
  });
});

describe('isDigestStatus', () => {
  it('accepts the five states and nothing else', () => {
    for (const status of ['none', 'pending', 'running', 'done', 'failed']) {
      expect(isDigestStatus(status)).toBe(true);
    }
    expect(isDigestStatus('ready')).toBe(false);
    expect(isDigestStatus(null)).toBe(false);
  });
});
