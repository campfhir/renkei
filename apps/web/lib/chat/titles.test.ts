import { deriveTitle } from './titles';

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
