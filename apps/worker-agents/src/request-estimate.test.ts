/**
 * When a run folds: estimateRunRequestTokens reads the run's own measured
 * usage the way chat's estimateRequestTokens reads a reply's, so the fold
 * fires on what the provider actually counted rather than a character
 * guess — and falls back to the guess where nothing measured applies.
 */

import { estimateRunRequestTokens } from './engine';

type Turn = Parameters<typeof estimateRunRequestTokens>[0][number];

function turn(attempt: number, detail: Turn['detail']): Turn {
  return {
    id: `turn-${attempt}`,
    attempt,
    status: 'succeeded',
    created_at: new Date(0),
    tool_call_count: 0,
    detail,
  };
}

const call = (inputTokens: number, outputTokens = 100) => ({
  durationMs: 1,
  stopReason: 'tool_use',
  inputTokens,
  outputTokens,
});

const result = (chars: number) => ({
  type: 'tool_result' as const,
  toolUseId: 'toolu_1',
  content: 'x'.repeat(chars),
});

describe('estimateRunRequestTokens', () => {
  it('estimates from characters before any call has measured the run', () => {
    expect(estimateRunRequestTokens([], 35_000)).toBe(10_000);
  });

  it('builds on the latest call’s usage, estimating only what came after it', () => {
    const turns = [
      turn(1, { modelCalls: [call(50_000)], results: [result(700)] }),
      turn(2, { modelCalls: [call(90_000)], results: [result(3_500)] }),
    ];
    // 90 000 read + 100 written + 3 500 characters of result since.
    expect(estimateRunRequestTokens(turns, 1)).toBe(90_100 + 1_000);
  });

  it('ignores a measurement taken before the newest fold', () => {
    const turns = [
      turn(1, { modelCalls: [call(150_000)] }),
      turn(2, { compaction: { summary: 'notes', through: 1 } }),
    ];
    expect(estimateRunRequestTokens(turns, 7_000)).toBe(2_000);
  });

  it('trusts a call made on the fold’s own turn, which came after it', () => {
    const turns = [
      turn(1, { modelCalls: [call(150_000)] }),
      turn(2, { compaction: { summary: 'notes', through: 1 }, modelCalls: [call(20_000, 0)] }),
    ];
    expect(estimateRunRequestTokens(turns, 7_000)).toBe(20_000);
  });
});
