import { parseTokenCount } from './format-tokens';

describe('parseTokenCount', () => {
  it('reads k and m suffixes', () => {
    expect(parseTokenCount('200k')).toBe(200_000);
    expect(parseTokenCount('1m')).toBe(1_000_000);
    expect(parseTokenCount('1.5M')).toBe(1_500_000);
    expect(parseTokenCount(' 128K ')).toBe(128_000);
  });

  it('reads decimals with a scale, rounded to whole tokens', () => {
    expect(parseTokenCount('1.5k')).toBe(1_500);
    expect(parseTokenCount('2.34k')).toBe(2_340);
    expect(parseTokenCount('5.56m')).toBe(5_560_000);
    expect(parseTokenCount('.5k')).toBe(500);
    expect(parseTokenCount('0.5m')).toBe(500_000);
    expect(parseTokenCount('1.0005k')).toBe(1_001);
    expect(parseTokenCount('1.23456789m')).toBe(1_234_568);
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
