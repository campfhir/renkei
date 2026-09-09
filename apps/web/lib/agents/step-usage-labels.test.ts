import { CURRENT_STEPS_VERSION } from '@renkei/agents';
import { labelStepUsage } from './step-usage-labels';
import type { UsageBuckets } from './agent-usage';

const zero: UsageBuckets = {
  today: 0,
  yesterday: 0,
  week: 0,
  month: 0,
  quarter: 0,
  year: 0,
  allTime: 0,
};

function row(stepId: string | null) {
  return {
    stepId,
    provider: 'anthropic',
    model: 'claude-x',
    calls: zero,
    input: zero,
    output: zero,
    cacheRead: zero,
    cacheWrite: zero,
  };
}

const doc = {
  version: CURRENT_STEPS_VERSION,
  steps: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Read the inbox',
      instruction: [{ t: 'text', v: 'Look at new mail.' }],
      tool: null,
      maxAttempts: 1,
      failureHandling: [],
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      kind: 'loop',
      mode: 'foreach',
      name: 'Each message',
      itemsVar: 'messages',
      itemVar: 'message',
      maxIterations: 10,
      steps: [
        {
          id: '33333333-3333-4333-8333-333333333333',
          name: 'Triage it',
          instruction: [{ t: 'text', v: 'Decide.' }],
          tool: null,
          maxAttempts: 1,
          failureHandling: [],
        },
      ],
    },
  ],
};

describe('labelStepUsage', () => {
  it('names and numbers top-level and nested steps from the current definition', () => {
    const labeled = labelStepUsage(doc, [
      row('11111111-1111-4111-8111-111111111111'),
      row('33333333-3333-4333-8333-333333333333'),
    ]);
    expect(labeled.map((entry) => [entry.stepNumber, entry.stepName])).toEqual([
      [1, 'Read the inbox'],
      // The loop is 2, so its first child is 3 — the outline's numbering.
      [3, 'Triage it'],
    ]);
  });

  it('leaves a removed step and spend outside any step unnamed', () => {
    const labeled = labelStepUsage(doc, [row('99999999-9999-4999-8999-999999999999'), row(null)]);
    expect(labeled.map((entry) => [entry.stepNumber, entry.stepName])).toEqual([
      [null, null],
      [null, null],
    ]);
    expect(labeled[0].stepId).toBe('99999999-9999-4999-8999-999999999999');
  });

  it('survives a definition it cannot read', () => {
    const labeled = labelStepUsage({ nonsense: true }, [
      row('11111111-1111-4111-8111-111111111111'),
    ]);
    expect(labeled[0].stepName).toBeNull();
  });
});
