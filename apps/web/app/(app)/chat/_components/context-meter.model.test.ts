import { compact, meterView } from './context-meter.model';

describe('the context ring', () => {
  it('shows how much of the window the conversation uses, with the exact counts in its tooltip', () => {
    expect(meterView(42_000, 200_000)).toEqual({
      fraction: 0.21,
      percent: 21,
      tone: 'normal',
      title: 'Context: 42k of 200k tokens (21%)',
    });
  });

  it('is not there for a model with no recorded window, or before there is a count', () => {
    expect(meterView(42_000, null)).toBeNull();
    expect(meterView(null, 200_000)).toBeNull();
  });

  it('an empty conversation is an empty ring', () => {
    expect(meterView(0, 200_000)).toMatchObject({ fraction: 0, percent: 0, tone: 'normal' });
  });

  it('turns amber from three quarters full and red from nine tenths', () => {
    expect(meterView(149_999, 200_000)?.tone).toBe('normal');
    expect(meterView(150_000, 200_000)?.tone).toBe('warning');
    expect(meterView(180_000, 200_000)?.tone).toBe('full');
  });

  it('past the window it is simply full', () => {
    expect(meterView(250_000, 200_000)).toMatchObject({
      fraction: 1,
      percent: 100,
      title: 'Context: 250k of 200k tokens (100%)',
    });
  });
});

describe('a token count, short', () => {
  it('is the number itself under a thousand', () => {
    expect(compact(950)).toBe('950');
  });

  it('is in thousands to a tenth, without a trailing .0', () => {
    expect(compact(1_000)).toBe('1k');
    expect(compact(42_000)).toBe('42k');
    expect(compact(8_320)).toBe('8.3k');
  });

  it('is in millions from a million', () => {
    expect(compact(1_000_000)).toBe('1M');
    expect(compact(1_500_000)).toBe('1.5M');
  });
});
