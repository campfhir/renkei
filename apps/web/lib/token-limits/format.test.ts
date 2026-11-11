import {
  formatReset,
  formatTokens,
  limitProgress,
  limitReachedNote,
  parseTokens,
  tokensFieldText,
} from './format';

describe('token amounts as written', () => {
  it('writes counts short', () => {
    expect([0, 999, 1000, 15_500, 250_000, 1_250_000, 3_000_000_000].map(formatTokens)).toEqual([
      '0',
      '999',
      '1K',
      '15.5K',
      '250K',
      '1.3M',
      '3B',
    ]);
  });

  it('reads what a person types', () => {
    expect(parseTokens('2M')).toBe(2_000_000);
    expect(parseTokens('500k')).toBe(500_000);
    expect(parseTokens(' 1.5 m ')).toBe(1_500_000);
    expect(parseTokens('1,500,000')).toBe(1_500_000);
    expect(parseTokens('3b')).toBe(3_000_000_000);
    expect(parseTokens('250')).toBe(250);
  });

  it('blank is zero, which for a limit means none', () => {
    expect(parseTokens('')).toBe(0);
    expect(parseTokens('   ')).toBe(0);
  });

  it('refuses what is not an amount', () => {
    expect(parseTokens('lots')).toBeNull();
    expect(parseTokens('-5')).toBeNull();
    expect(parseTokens('2MM')).toBeNull();
    expect(parseTokens('9999999b')).toBeNull();
  });

  it('a stored limit comes back as text that reads to the same number', () => {
    for (const tokens of [0, 250, 1_000, 1_500, 1_250_000, 2_000_000, 1_234_567, 3_000_000_000]) {
      expect(parseTokens(tokensFieldText(tokens))).toBe(tokens);
    }
    expect(tokensFieldText(0)).toBe('');
    expect(tokensFieldText(2_000_000)).toBe('2M');
    expect(tokensFieldText(1_250_000)).toBe('1.25M');
    expect(tokensFieldText(1_234_567)).toBe('1234567');
  });
});

describe('progress against a limit', () => {
  it('with no limit there is only what was used', () => {
    expect(limitProgress(350_000, null)).toMatchObject({
      limit: null,
      percent: 0,
      reached: false,
      label: '350K used',
    });
  });

  it('shows the share used', () => {
    expect(limitProgress(350_000, 1_000_000)).toMatchObject({
      percent: 35,
      reached: false,
      near: false,
      label: '350K of 1M',
    });
  });

  it('warns within a fifth of the limit', () => {
    expect(limitProgress(800, 1000).near).toBe(true);
    expect(limitProgress(799, 1000).near).toBe(false);
  });

  it('at the limit it is reached, and the bar stays full past it', () => {
    expect(limitProgress(1000, 1000)).toMatchObject({ percent: 100, reached: true, near: false });
    expect(limitProgress(2500, 1000)).toMatchObject({ percent: 100, reached: true });
  });

  it('a boost raises the limit in force', () => {
    expect(limitProgress(1200, 1000, 500)).toMatchObject({
      limit: 1500,
      percent: 80,
      reached: false,
      label: '1.2K of 1.5K',
    });
  });
});

describe('what the model picker says of a model at a limit', () => {
  it('names the model’s own limit and its reset', () => {
    expect(
      limitReachedNote({ period: 'week', llmModelId: 'm', resetsAt: '2026-11-16T00:00:00.000Z' })
    ).toBe('Weekly limit for this model reached · resets Mon 16 Nov, 00:00 UTC');
    expect(
      limitReachedNote({ period: 'month', llmModelId: 'm', resetsAt: '2026-12-01T00:00:00.000Z' })
    ).toBe('Monthly limit for this model reached · resets Tue 1 Dec, 00:00 UTC');
  });

  it('tells the reset on the organization’s clock', () => {
    expect(
      limitReachedNote({
        period: 'week',
        llmModelId: 'm',
        resetsAt: '2026-11-16T05:00:00.000Z',
        timeZone: 'America/New_York',
      })
    ).toBe('Weekly limit for this model reached · resets Mon 16 Nov, 00:00 EST');
  });

  it('says so when it is the person’s overall limit', () => {
    expect(
      limitReachedNote({ period: 'week', llmModelId: null, resetsAt: '2026-11-16T00:00:00.000Z' })
    ).toBe('Your weekly token limit is reached · resets Mon 16 Nov, 00:00 UTC');
  });
});

it('a reset is written with its zone', () => {
  expect(formatReset('2026-11-16T00:00:00.000Z')).toBe('Mon 16 Nov, 00:00 UTC');
  expect(formatReset('nonsense')).toBe('');
  expect(formatReset('2026-11-16T05:00:00.000Z', 'America/New_York')).toBe('Mon 16 Nov, 00:00 EST');
  expect(formatReset('2026-07-06T04:00:00.000Z', 'America/New_York')).toBe('Mon 6 Jul, 00:00 EDT');
  // A zone this runtime does not know still says something true.
  expect(formatReset('2026-11-16T00:00:00.000Z', 'Mars/Olympus')).toBe('Mon 16 Nov, 00:00 UTC');
});
