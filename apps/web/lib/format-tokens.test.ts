import { parseTokenCount } from './format-tokens';

describe('parseTokenCount', () => {
  it('reads k and m suffixes', () => {
    expect(parseTokenCount('200k')).toBe(200_000);
    expect(parseTokenCount('1m')).toBe(1_000_000);
    expect(parseTokenCount('1.5M')).toBe(1_500_000);
    expect(parseTokenCount(' 128K ')).toBe(128_000);
  });

  it('reads plain and comma-grouped numbers', () => {
    expect(parseTokenCount('200000')).toBe(200_000);
    expect(parseTokenCount('200,000')).toBe(200_000);
  });

  it('refuses what is not a positive token count', () => {
    for (const input of ['', 'abc', '-5k', '0', '0k', '1.5', '2x', 'k', '1mm']) {
      expect(parseTokenCount(input)).toBeNull();
    }
  });
});
