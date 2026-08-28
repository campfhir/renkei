import { settledNumber, typedNumber } from './use-numeric-input';

describe('typedNumber', () => {
  it('commits a real number', () => {
    expect(typedNumber('3')).toBe(3);
    expect(typedNumber('-3')).toBe(-3);
    expect(typedNumber('0')).toBe(0);
  });

  it('withholds while the field is empty — Number("") is 0, which is a lie', () => {
    expect(typedNumber('')).toBeNull();
    expect(typedNumber('   ')).toBeNull();
  });

  it('withholds on a lone minus, so typing -3 keeps its sign', () => {
    // The whole bug: "-" parsed to NaN, fell back to 0, and the next
    // keystroke produced 3 instead of -3.
    expect(typedNumber('-')).toBeNull();
  });

  it('withholds on text that is not a number at all', () => {
    expect(typedNumber('abc')).toBeNull();
  });
});

describe('settledNumber', () => {
  it('keeps the last good value when the field is left empty', () => {
    expect(settledNumber('', 5)).toBe(5);
    expect(settledNumber('-', 5)).toBe(5);
  });

  it('takes what was typed when it is a number', () => {
    expect(settledNumber('-3', 1)).toBe(-3);
  });

  it('applies the caller’s normalization only on settle', () => {
    const clamp = (n: number) => Math.min(Math.max(Math.round(n), 1), 10);
    expect(settledNumber('50', 3, clamp)).toBe(10);
    expect(settledNumber('0', 3, clamp)).toBe(1);
    expect(settledNumber('2.6', 3, clamp)).toBe(3);
    // Nothing typed: the fallback is returned UNnormalized, because it was
    // already a settled value.
    expect(settledNumber('', 7, clamp)).toBe(7);
  });
});
