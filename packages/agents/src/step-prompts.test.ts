/**
 * The outcome guide is the ONLY thing steering a model into an
 * author-invented condition code, and the author's non-retry prose rides
 * it too — so its rendering is pinned here, pinned beside the builders it rides with.
 */

import { randomUUID } from 'node:crypto';
import { buildAttemptMessages, outcomeGuideFor } from './step-prompts';
import type { ActionStep } from './steps';

function step(overrides: Partial<ActionStep> = {}): ActionStep {
  return {
    id: randomUUID(),
    name: 'Find the statement',
    instruction: [{ t: 'text', v: 'Find it.' }],
    tool: 'jira_search_issues',
    maxAttempts: 3,
    failureHandling: [],
    ...overrides,
  };
}

describe('outcomeGuideFor', () => {
  it('is absent without a tool or without handling', () => {
    expect(outcomeGuideFor(step({ tool: null }), {})).toBeUndefined();
    expect(outcomeGuideFor(step(), {})).toBeUndefined();
  });

  it('lists custom conditions with their applies-when text', () => {
    const guide = outcomeGuideFor(
      step({
        failureHandling: [
          {
            outcome: 'poor-match',
            action: 'retry',
            when: 'results exist but none match the description closely enough',
            guidance: [{ t: 'text', v: 'Reword the search.' }],
          },
        ],
      }),
      {}
    );
    expect(guide).toContain(
      '"poor-match" (applies when: results exist but none match the description closely enough)'
    );
    // The reasoned-classification rule: a technically-successful call can
    // still BE a planned condition.
    expect(guide).toContain('technically succeeded');
  });

  it('renders non-retry prose as author notes, with variables resolved', () => {
    const guide = outcomeGuideFor(
      step({
        failureHandling: [
          {
            outcome: 'not-found',
            action: 'continue',
            guidance: [
              { t: 'text', v: 'That is a valid answer for ' },
              { t: 'var', name: 'the ticket' },
            ],
          },
        ],
      }),
      { 'the ticket': 'ENG-808' }
    );
    expect(guide).toContain('the author notes: That is a valid answer for ENG-808');
  });

  it('never leaks retry guidance into the guide — it belongs to attempts ≥ 2', () => {
    const guide = outcomeGuideFor(
      step({
        failureHandling: [
          {
            outcome: 'no-results',
            action: 'retry',
            guidance: [{ t: 'text', v: 'Broaden the search terms.' }],
          },
        ],
      }),
      {}
    );
    expect(guide).not.toContain('Broaden the search terms.');
    // The no-results special case still rides along.
    expect(guide).toContain('runs cleanly but matches nothing');
  });
});

describe('attempt chips', () => {
  it('binds [attempt] and [attempt.max] in the instruction', () => {
    const built = buildAttemptMessages({
      step: step({
        maxAttempts: 3,
        instruction: [
          { t: 'text', v: 'Try ' },
          { t: 'var', name: 'attempt' },
          { t: 'text', v: ' of ' },
          { t: 'var', name: 'attempt.max' },
          { t: 'text', v: '.' },
        ],
      }),
      attempt: 2,
      variables: {},
      toolBudget: 3,
    });

    expect(built.messages[0].content[0].text).toContain('Instruction: Try 2 of 3.');
    expect(built.unbound).toEqual([]);
  });

  it('reads "try 1 of 3" on the first pass, not zero', () => {
    const built = buildAttemptMessages({
      step: step({
        maxAttempts: 3,
        instruction: [
          { t: 'text', v: 'Try ' },
          { t: 'var', name: 'attempt' },
          { t: 'text', v: '.' },
        ],
      }),
      attempt: 1,
      variables: {},
      toolBudget: 3,
    });

    expect(built.messages[0].content[0].text).toContain('Instruction: Try 1.');
  });

  it('keeps the attempt chips out of "Known information"', () => {
    const built = buildAttemptMessages({
      step: step({ maxAttempts: 3 }),
      attempt: 2,
      variables: { today: '2026-08-28' },
      toolBudget: 3,
    });
    const text = built.messages[0].content[0].text;

    // The prompt states the attempt in its own words; repeating it as
    // known information is noise on every first attempt.
    expect(text).toContain('Known information:\n- today: 2026-08-28');
    expect(text).not.toContain('- attempt: 2');
    expect(text).not.toContain('- attempt.max: 3');
  });
});
