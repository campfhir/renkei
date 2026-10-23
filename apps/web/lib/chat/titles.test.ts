import { cleanTitle, deriveTitle } from './titles';

describe('deriveTitle', () => {
  it('takes the first non-empty line, collapsed', () => {
    expect(deriveTitle('\n\n  Hello   world  \nsecond')).toBe('Hello world');
  });
  it('cuts long text at a word boundary with an ellipsis', () => {
    const title = deriveTitle('word '.repeat(40));
    expect(title.length).toBeLessThanOrEqual(61);
    expect(title.endsWith('…')).toBe(true);
    expect(title).not.toContain('  ');
  });
  it('falls back for blank input', () => {
    expect(deriveTitle('   ')).toBe('New chat');
  });
});

describe('cleanTitle', () => {
  it('takes the first line, without wrapping quotes', () => {
    expect(cleanTitle('"Quarterly   budget review"\nmore')).toBe('Quarterly budget review');
  });
  it('cuts long titles like deriveTitle does', () => {
    const title = cleanTitle('word '.repeat(40));
    expect(title?.endsWith('…')).toBe(true);
    expect(title?.length).toBeLessThanOrEqual(61);
  });
  it('is null when nothing is left to show', () => {
    expect(cleanTitle('  \n  ')).toBeNull();
    expect(cleanTitle('""')).toBeNull();
  });
});
