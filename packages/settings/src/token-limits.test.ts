/**
 * Token limits: when a week begins, what counts against a limit, what a
 * boost and an exemption change, and which limit stops new work.
 */

import {
  createMemoryDataStore,
  registerDataStore,
  resetDataStore,
  type MemoryDataStore,
} from '@renkei/db';
import { DEFAULT_ORG_SETTINGS, invalidateSettingsCache, isTimeZone, setOrgSettings } from './index';
import {
  buildTokenLimitStatus,
  checkTokenLimit,
  formatResetAt,
  formatTokenCount,
  getTokenLimitStatus,
  monthStart,
  nextMonthStart,
  tokenLimitPolicy,
  weekBounds,
  tokenLimitBlock,
  tokenLimitMessage,
  tokenLimitPeriods,
  weekStart,
  type TokenLimitInputs,
  type TokenLimitPolicy,
} from './token-limits';

const utc = (iso: string) => new Date(`${iso}Z`);
const MODEL = '00000000-0000-4000-8000-000000000901';
const OTHER = '00000000-0000-4000-8000-000000000902';

const policy: TokenLimitPolicy = {
  weekly: 1000,
  monthly: 3000,
  weekResetDay: 1,
  weekResetMinute: 0,
  timeZone: 'UTC',
  models: {},
};

// A Wednesday.
const now = utc('2026-11-11T15:30:00');

function inputs(overrides: Partial<TokenLimitInputs> = {}): TokenLimitInputs {
  return { policy, now, exempt: false, boosts: [], weekSpend: [], monthSpend: [], ...overrides };
}

function boost(period: 'week' | 'month', tokens: number, expiresAt: Date) {
  return {
    id: `${period}-${tokens}`,
    subject: 'ann',
    period,
    tokens,
    expiresAt,
    grantedBy: 'olive',
    note: null,
    createdAt: utc('2026-11-10T00:00:00'),
  };
}

describe('when a period begins', () => {
  it('the week begins Monday at 00:00 UTC by default', () => {
    expect(weekStart(now, 1, 0)).toEqual(utc('2026-11-09T00:00:00'));
  });

  it('on the reset day itself the week begins that day, once the time has come', () => {
    expect(weekStart(utc('2026-11-09T00:00:00'), 1, 0)).toEqual(utc('2026-11-09T00:00:00'));
    expect(weekStart(utc('2026-11-09T08:59:00'), 1, 9 * 60)).toEqual(utc('2026-11-02T09:00:00'));
    expect(weekStart(utc('2026-11-09T09:00:00'), 1, 9 * 60)).toEqual(utc('2026-11-09T09:00:00'));
  });

  it('follows the day and time the organization chose', () => {
    // Friday 17:30 UTC.
    expect(weekStart(now, 5, 17 * 60 + 30)).toEqual(utc('2026-11-06T17:30:00'));
    // Sunday.
    expect(weekStart(now, 0, 0)).toEqual(utc('2026-11-08T00:00:00'));
  });

  it('the week resets seven days after it began; the month on the 1st', () => {
    const periods = tokenLimitPeriods(policy, now);
    expect(periods.week.resetsAt).toEqual(utc('2026-11-16T00:00:00'));
    expect(monthStart(now)).toEqual(utc('2026-11-01T00:00:00'));
    expect(periods.month.resetsAt).toEqual(utc('2026-12-01T00:00:00'));
    expect(tokenLimitPeriods(policy, utc('2026-12-31T23:59:00')).month.resetsAt).toEqual(
      utc('2027-01-01T00:00:00')
    );
  });
});

describe('resets told in the organization’s time zone', () => {
  const NEW_YORK = 'America/New_York';
  const KOLKATA = 'Asia/Kolkata';

  it('Monday at midnight in New York is 05:00 UTC in winter', () => {
    expect(weekStart(now, 1, 0, NEW_YORK)).toEqual(utc('2026-11-09T05:00:00'));
    expect(weekBounds(now, 1, 0, NEW_YORK).resetsAt).toEqual(utc('2026-11-16T05:00:00'));
  });

  it('early Monday UTC is still Sunday in New York: last week has not ended there', () => {
    expect(weekStart(utc('2026-11-16T03:00:00'), 1, 0, NEW_YORK)).toEqual(
      utc('2026-11-09T05:00:00')
    );
    expect(weekStart(utc('2026-11-16T05:00:00'), 1, 0, NEW_YORK)).toEqual(
      utc('2026-11-16T05:00:00')
    );
  });

  it('a zone ahead of UTC resets before UTC midnight', () => {
    // Monday 09:00 in Kolkata (UTC+5:30) is 03:30 UTC.
    expect(weekStart(now, 1, 9 * 60, KOLKATA)).toEqual(utc('2026-11-09T03:30:00'));
  });

  it('the reset keeps its wall-clock time across a daylight-saving change', () => {
    // Clocks in New York go back on Sunday 1 November 2026.
    const before = weekBounds(utc('2026-10-28T12:00:00'), 1, 9 * 60, NEW_YORK);
    expect(before.startsAt).toEqual(utc('2026-10-26T13:00:00'));
    expect(before.resetsAt).toEqual(utc('2026-11-02T14:00:00'));
    // And forward on Sunday 8 March 2026.
    const spring = weekBounds(utc('2026-03-04T12:00:00'), 1, 9 * 60, NEW_YORK);
    expect(spring.startsAt).toEqual(utc('2026-03-02T14:00:00'));
    expect(spring.resetsAt).toEqual(utc('2026-03-09T13:00:00'));
  });

  it('the month begins on the 1st at midnight there', () => {
    expect(monthStart(now, NEW_YORK)).toEqual(utc('2026-11-01T04:00:00'));
    expect(nextMonthStart(now, NEW_YORK)).toEqual(utc('2026-12-01T05:00:00'));
    // 02:00 UTC on 1 December is still November in New York.
    expect(monthStart(utc('2026-12-01T02:00:00'), NEW_YORK)).toEqual(utc('2026-11-01T04:00:00'));
    expect(nextMonthStart(utc('2026-12-31T23:00:00'), KOLKATA)).toEqual(utc('2027-01-31T18:30:00'));
  });

  it('a reset is written on that zone’s clock, with its name', () => {
    expect(formatResetAt(utc('2026-11-16T05:00:00'), NEW_YORK)).toBe(
      'Monday 16 November at 00:00 EST'
    );
    expect(formatResetAt(utc('2026-07-06T04:00:00'), NEW_YORK)).toBe('Monday 6 July at 00:00 EDT');
  });

  it('a zone name Intl does not know falls back to UTC', () => {
    const base = { ...DEFAULT_ORG_SETTINGS, tokenLimitTimeZone: 'Mars/Olympus' };
    expect(tokenLimitPolicy(base).timeZone).toBe('UTC');
    expect(isTimeZone('America/New_York')).toBe(true);
    expect(isTimeZone('UTC')).toBe(true);
    expect(isTimeZone('')).toBe(false);
  });

  it('a refusal shown to someone else leaves the figures out', () => {
    const block = {
      period: 'week' as const,
      llmModelId: null,
      limit: 1000,
      used: 1000,
      resetsAt: utc('2026-11-16T05:00:00'),
      timeZone: NEW_YORK,
    };
    const message = tokenLimitMessage(block, {
      whose: "This agent's owner has",
      showUsage: false,
    });
    expect(message).toContain("This agent's owner has reached the weekly token limit. It resets");
    expect(message).not.toMatch(/\d+(\.\d+)?[kKmM]? of /);
    expect(tokenLimitMessage(block)).toMatch(/ of /);
  });

  it('a refusal names the reset in that zone', () => {
    expect(
      tokenLimitMessage({
        period: 'week',
        llmModelId: null,
        limit: 1000,
        used: 1000,
        resetsAt: utc('2026-11-16T05:00:00'),
        timeZone: NEW_YORK,
      })
    ).toContain('It resets Monday 16 November at 00:00 EST.');
  });
});

describe('where a person stands', () => {
  it('every model counts toward the person, chats and agents alike', () => {
    const status = buildTokenLimitStatus(
      inputs({
        weekSpend: [
          { llmModelId: MODEL, tokens: 300 },
          { llmModelId: null, tokens: 50 },
        ],
        monthSpend: [{ llmModelId: MODEL, tokens: 900 }],
      })
    );
    expect(status.week).toMatchObject({ limit: 1000, boost: 0, used: 350 });
    expect(status.month).toMatchObject({ limit: 3000, used: 900 });
  });

  it('a limit of 0 is no limit', () => {
    const status = buildTokenLimitStatus(
      inputs({
        policy: { ...policy, weekly: 0, monthly: 0 },
        weekSpend: [{ llmModelId: MODEL, tokens: 9_999_999 }],
      })
    );
    expect(status.week.limit).toBeNull();
    expect(tokenLimitBlock(status, MODEL)).toBeNull();
  });

  it('under the limit, work starts', () => {
    const status = buildTokenLimitStatus(
      inputs({ weekSpend: [{ llmModelId: MODEL, tokens: 999 }] })
    );
    expect(tokenLimitBlock(status, MODEL)).toBeNull();
  });

  it('at the weekly limit nothing new starts until the week resets', () => {
    const status = buildTokenLimitStatus(
      inputs({ weekSpend: [{ llmModelId: MODEL, tokens: 1000 }] })
    );
    expect(tokenLimitBlock(status, null)).toEqual({
      period: 'week',
      llmModelId: null,
      limit: 1000,
      used: 1000,
      resetsAt: utc('2026-11-16T00:00:00'),
      timeZone: 'UTC',
    });
  });

  it('the monthly limit stops work even when the week has room', () => {
    const status = buildTokenLimitStatus(
      inputs({
        weekSpend: [{ llmModelId: MODEL, tokens: 10 }],
        monthSpend: [{ llmModelId: MODEL, tokens: 3500 }],
      })
    );
    expect(tokenLimitBlock(status, MODEL)).toMatchObject({
      period: 'month',
      limit: 3000,
      used: 3500,
      resetsAt: utc('2026-12-01T00:00:00'),
    });
  });

  it('a weekly boost raises the week and leaves the month alone', () => {
    const status = buildTokenLimitStatus(
      inputs({
        boosts: [boost('week', 500, utc('2026-11-16T00:00:00'))],
        weekSpend: [{ llmModelId: MODEL, tokens: 1200 }],
        monthSpend: [{ llmModelId: MODEL, tokens: 1200 }],
      })
    );
    expect(status.week.boost).toBe(500);
    expect(status.month.boost).toBe(0);
    expect(tokenLimitBlock(status, MODEL)).toBeNull();
  });

  it('boosts add up, and a spent boost stops work again', () => {
    const status = buildTokenLimitStatus(
      inputs({
        boosts: [
          boost('week', 500, utc('2026-11-16T00:00:00')),
          boost('week', 100, utc('2026-11-16T00:00:00')),
        ],
        weekSpend: [{ llmModelId: MODEL, tokens: 1600 }],
      })
    );
    expect(tokenLimitBlock(status, MODEL)).toMatchObject({ period: 'week', limit: 1600 });
  });

  it('a boost whose period has ended counts for nothing', () => {
    const status = buildTokenLimitStatus(
      inputs({
        boosts: [boost('week', 500, utc('2026-11-09T00:00:00'))],
        weekSpend: [{ llmModelId: MODEL, tokens: 1000 }],
      })
    );
    expect(status.week.boost).toBe(0);
    expect(status.boosts).toEqual([]);
    expect(tokenLimitBlock(status, MODEL)).not.toBeNull();
  });

  it('an exempt person is never stopped, and still sees what they used', () => {
    const status = buildTokenLimitStatus(
      inputs({ exempt: true, weekSpend: [{ llmModelId: MODEL, tokens: 50_000 }] })
    );
    expect(status.week.used).toBe(50_000);
    expect(tokenLimitBlock(status, MODEL)).toBeNull();
  });
});

describe('a limit on one model', () => {
  const withModel: TokenLimitPolicy = {
    ...policy,
    weekly: 0,
    monthly: 0,
    models: { [MODEL]: { weekly: 100, monthly: 0 } },
  };

  it('stops that model and leaves the others', () => {
    const status = buildTokenLimitStatus(
      inputs({
        policy: withModel,
        weekSpend: [
          { llmModelId: MODEL, tokens: 150 },
          { llmModelId: OTHER, tokens: 9000 },
        ],
      })
    );
    expect(status.models).toEqual([
      { llmModelId: MODEL, week: { limit: 100, used: 150 }, month: { limit: null, used: 0 } },
    ]);
    expect(tokenLimitBlock(status, MODEL)).toMatchObject({
      period: 'week',
      llmModelId: MODEL,
      limit: 100,
      used: 150,
    });
    expect(tokenLimitBlock(status, OTHER)).toBeNull();
    expect(tokenLimitBlock(status, null)).toBeNull();
  });

  it('a boost does not raise a model limit', () => {
    const status = buildTokenLimitStatus(
      inputs({
        policy: withModel,
        boosts: [boost('week', 5000, utc('2026-11-16T00:00:00'))],
        weekSpend: [{ llmModelId: MODEL, tokens: 100 }],
      })
    );
    expect(tokenLimitBlock(status, MODEL)).not.toBeNull();
  });

  it('the overall limit is named first when both are reached', () => {
    const status = buildTokenLimitStatus(
      inputs({
        policy: { ...withModel, weekly: 120 },
        weekSpend: [{ llmModelId: MODEL, tokens: 150 }],
      })
    );
    expect(tokenLimitBlock(status, MODEL)).toMatchObject({ llmModelId: null, limit: 120 });
  });
});

describe('what a refusal says', () => {
  it('names the limit, the use and the reset', () => {
    expect(
      tokenLimitMessage({
        period: 'week',
        llmModelId: null,
        limit: 2_000_000,
        used: 2_150_000,
        resetsAt: utc('2026-11-16T00:00:00'),
      })
    ).toBe(
      'You have reached the weekly token limit (2.2M of 2M). It resets Monday 16 November at 00:00 UTC. An operator can grant a boost.'
    );
  });

  it('names the model and whose limit it is', () => {
    expect(
      tokenLimitMessage(
        {
          period: 'month',
          llmModelId: MODEL,
          limit: 500,
          used: 512,
          resetsAt: utc('2026-12-01T00:00:00'),
        },
        { modelLabel: 'Opus', whose: 'Ada Lovelace has' }
      )
    ).toBe(
      'Ada Lovelace has reached the monthly token limit for the model Opus (512 of 500). It resets Tuesday 1 December at 00:00 UTC. Another model can still be used.'
    );
  });

  it('writes counts short', () => {
    expect([999, 1000, 15_500, 250_000, 1_250_000, 3_000_000_000].map(formatTokenCount)).toEqual([
      '999',
      '1K',
      '15.5K',
      '250K',
      '1.3M',
      '3B',
    ]);
    expect(formatResetAt(utc('2026-11-13T17:05:00'))).toBe('Friday 13 November at 17:05 UTC');
  });
});

describe('read from the store', () => {
  let store: MemoryDataStore;

  async function spend(subject: string, tokens: number, llmModelId: string | null = MODEL) {
    await store.usage.recordLlmCall({
      subject,
      agentId: null,
      runId: null,
      stepId: null,
      purpose: 'chat',
      inputTokens: tokens,
      outputTokens: 0,
      cacheReadInputTokens: null,
      cacheWriteInputTokens: null,
      llmModelId,
      provider: null,
      model: null,
      durationMs: null,
    });
  }

  beforeEach(() => {
    store = createMemoryDataStore();
    registerDataStore(store);
    invalidateSettingsCache();
  });
  afterEach(() => {
    resetDataStore();
    invalidateSettingsCache();
  });

  it('with no limits set, nobody is stopped', async () => {
    await spend('ann', 1_000_000);
    expect(await checkTokenLimit('ann', MODEL)).toBeNull();
  });

  it('a person past the weekly limit is stopped; another person is not', async () => {
    await setOrgSettings({ tokenLimitWeekly: 500 });
    await spend('ann', 600);
    await spend('bob', 100);
    expect(await checkTokenLimit('ann', MODEL)).toMatchObject({ period: 'week', used: 600 });
    expect(await checkTokenLimit('bob', MODEL)).toBeNull();
  });

  it('a boost for the week lets them go on, until it is taken back', async () => {
    await setOrgSettings({ tokenLimitWeekly: 500 });
    await spend('ann', 600);
    const status = await getTokenLimitStatus('ann');
    if (!status.ok) throw new Error('status');
    await store.tokenLimits.grantBoost({
      id: '00000000-0000-4000-8000-000000000001',
      subject: 'ann',
      period: 'week',
      tokens: 200,
      expiresAt: status.val.week.resetsAt,
      grantedBy: 'olive',
      note: null,
    });
    expect(await checkTokenLimit('ann', MODEL)).toBeNull();
    await store.tokenLimits.revokeBoost('00000000-0000-4000-8000-000000000001');
    expect(await checkTokenLimit('ann', MODEL)).not.toBeNull();
  });

  it('an exempt person goes on', async () => {
    await setOrgSettings({ tokenLimitWeekly: 500 });
    await spend('ann', 600);
    await store.tokenLimits.setExempt('ann', true, 'olive');
    expect(await checkTokenLimit('ann', MODEL)).toBeNull();
  });

  it('a model limit stops that model only', async () => {
    await setOrgSettings({ modelTokenLimits: { [MODEL]: { weekly: 100, monthly: 0 } } });
    await spend('ann', 150, MODEL);
    expect(await checkTokenLimit('ann', MODEL)).toMatchObject({ llmModelId: MODEL });
    expect(await checkTokenLimit('ann', OTHER)).toBeNull();
  });
});
