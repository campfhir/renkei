/**
 * The outcome guide is the ONLY thing steering a model into an
 * author-invented condition code, and the author's non-retry prose rides
 * it too — so its rendering is pinned here, pinned beside the builders it rides with.
 */

import { randomUUID } from 'node:crypto';
import {
  INLINE_VALUE_MAX,
  buildAttemptMessages,
  buildBranchMessages,
  outcomeGuideFor,
  usesTime,
} from './step-prompts';
import type { BranchStep } from './steps';
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

describe('usesTime', () => {
  it('is true when the prose is about when', () => {
    expect(usesTime([[{ t: 'text', v: 'Find mail from yesterday evening.' }]])).toBe(true);
    expect(usesTime([[{ t: 'text', v: 'Meetings after 9 am count.' }]])).toBe(true);
    expect(usesTime([[], [{ t: 'text', v: 'Retry with last week instead.' }]])).toBe(true);
  });

  it('is true when the tool takes a date-shaped parameter', () => {
    expect(
      usesTime([[{ t: 'text', v: 'Find it.' }]], {
        type: 'object',
        properties: { since: { type: 'string' } },
      })
    ).toBe(true);
    expect(
      usesTime([[{ t: 'text', v: 'Find it.' }]], {
        type: 'object',
        properties: { cutoff: { type: 'string', format: 'date-time' } },
      })
    ).toBe(true);
  });

  it('is false for a step that has nothing to do with time — "I am" is not 9 am', () => {
    expect(usesTime([[{ t: 'text', v: 'I am looking up the ticket. Comment on it.' }]])).toBe(
      false
    );
    expect(
      usesTime([[{ t: 'text', v: 'Find it.' }]], {
        type: 'object',
        properties: { issueKey: { type: 'string' } },
      })
    ).toBe(false);
    // A date chip is resolved before the model reads it; not a reason.
    expect(
      usesTime([
        [
          { t: 'date', amount: -1, unit: 'day', timezone: 'UTC' },
          { t: 'text', v: 'Find it.' },
        ],
      ])
    ).toBe(false);
  });
});

describe('the dates paragraph', () => {
  it('rides only when resolve_time is offered', () => {
    const withTime = buildAttemptMessages({
      step: step(),
      attempt: 1,
      variables: {},
      toolBudget: 3,
      offersTime: true,
    }).messages[0].content[0].text;
    expect(withTime).toContain('finish_step and resolve_time are free');
    expect(withTime).toContain('Dates: never work out a timestamp');

    const without = buildAttemptMessages({
      step: step(),
      attempt: 1,
      variables: {},
      toolBudget: 3,
    }).messages[0].content[0].text;
    expect(without).toContain('(finish_step is free)');
    expect(without).not.toContain('resolve_time');
  });
});

describe('Known information lists what the step references, each value once', () => {
  const long = 'L'.repeat(INLINE_VALUE_MAX + 1);
  const variables = {
    today: '2026-09-09',
    'trigger.text': 'Be on the lookout for a text.',
    'trigger.nearbyMessages': 'a very long dump of messages',
    ticket: 'CAS-24851',
    'final summary': long,
    'thread context': 'unreferenced and never sent',
  };

  it('drops what no chip names, inlines short values, lists long ones once', () => {
    const built = buildAttemptMessages({
      step: step({
        instruction: [
          { t: 'text', v: 'Combine ' },
          { t: 'var', name: 'final summary' },
          { t: 'text', v: ' for ' },
          { t: 'var', name: 'ticket' },
          { t: 'text', v: ' per ' },
          { t: 'var', name: 'final summary' },
        ],
      }),
      attempt: 1,
      variables,
      toolBudget: 3,
    });
    const text = built.messages[0].content[0].text;

    expect(text).toContain(
      'Instruction: Combine [final summary] for CAS-24851 per [final summary]'
    );
    expect(text).toContain(
      `Known information ([name] in the instruction refers to an entry here):\n- today: 2026-09-09\n- final summary: ${long}`
    );
    // Once, not three times; the short value is inline only.
    expect(text.split(long)).toHaveLength(2);
    expect(text).not.toContain('- ticket:');
    expect(text).not.toContain('nearbyMessages');
    expect(text).not.toContain('thread context');
    expect(text).not.toContain('- trigger.text');
  });

  it('lists a trigger input only when a chip names it', () => {
    const chipped = buildAttemptMessages({
      step: step({
        instruction: [
          { t: 'text', v: 'Consider ' },
          { t: 'var', name: 'trigger.nearbyMessages' },
        ],
      }),
      attempt: 1,
      variables,
      toolBudget: 3,
    }).messages[0].content[0].text;
    // Short enough to inline, so inline only.
    expect(chipped).toContain('Consider a very long dump of messages');
    expect(chipped).not.toContain('- trigger.nearbyMessages');
  });

  it('lists a var referenced only in retry guidance, and the live loop inputs', () => {
    const text = buildAttemptMessages({
      step: step({
        failureHandling: [
          {
            outcome: 'no-results',
            action: 'retry',
            guidance: [
              { t: 'text', v: 'Search for ' },
              { t: 'var', name: 'ticket' },
            ],
          },
        ],
      }),
      attempt: 1,
      variables: { ...variables, item: 'one' },
      toolBudget: 3,
      inputs: ['item'],
    }).messages[0].content[0].text;
    expect(text).toContain(
      'Known information:\n- today: 2026-09-09\n- ticket: CAS-24851\n- item: one'
    );
  });

  it('applies the same rule to a branch condition', () => {
    const branch: BranchStep = {
      id: randomUUID(),
      kind: 'branch',
      name: 'Relevant?',
      condition: [
        { t: 'text', v: 'Based on ' },
        { t: 'var', name: 'final summary' },
        { t: 'text', v: ', is it relevant?' },
      ],
      paths: [
        { id: randomUUID(), name: 'Yes', steps: [] },
        { id: randomUUID(), name: 'No', steps: [] },
      ],
      maxAttempts: 2,
    };
    const text = buildBranchMessages({ branch, variables, attempt: 1 }).messages[0].content[0].text;
    expect(text).toContain('Condition to decide: Based on [final summary], is it relevant?');
    expect(text.split(long)).toHaveLength(2);
    expect(text).not.toContain('- ticket:');
    expect(text).not.toContain('nearbyMessages');
  });
});
