/**
 * Chips → prompt text. What matters: tool chips become the exact callable
 * name, var chips become their values, and an unbound var is LOUD — both
 * in the text and in the report — because silence there becomes a model
 * acting on an empty string.
 */

import { describeFailureHandling, instructionPreview, renderInstruction } from './render';
import type { InstructionSegment } from './steps';

const segments: InstructionSegment[] = [
  { t: 'text', v: 'Look up the ticket in ' },
  { t: 'var', name: 'trigger.subject' },
  { t: 'text', v: ' using ' },
  { t: 'tool', name: 'jira_get_issue' },
];

describe('renderInstruction', () => {
  it('substitutes vars and names tools canonically', () => {
    const { text, unbound } = renderInstruction(segments, {
      'trigger.subject': 'PROJ-42 is broken',
    });
    expect(text).toBe('Look up the ticket in PROJ-42 is broken using jira_get_issue');
    expect(unbound).toEqual([]);
  });

  it('marks and reports unbound vars instead of rendering nothing', () => {
    const { text, unbound } = renderInstruction(segments, {});
    expect(text).toContain('(unknown: trigger.subject)');
    expect(unbound).toEqual(['trigger.subject']);
  });
});

describe('instructionPreview', () => {
  it('brackets chips so history reads at a glance', () => {
    expect(instructionPreview(segments)).toBe(
      'Look up the ticket in [trigger.subject] using [jira_get_issue]'
    );
  });
});

describe('date chips resolve before the model reads anything', () => {
  // Fixed clock: 2026-08-25 10:00 PDT.
  const now = new Date('2026-08-25T17:00:00Z');
  const LA = 'America/Los_Angeles';

  it('renders yesterday 19:00 Los Angeles as a literal instant', () => {
    const { text } = renderInstruction(
      [
        { t: 'text', v: 'Find mail since ' },
        { t: 'date', amount: -1, unit: 'day', timezone: LA, atTime: '19:00' },
        { t: 'text', v: '.' },
      ],
      {},
      now
    );
    // The prompt carries the answer — there is nothing left to work out.
    expect(text).toBe('Find mail since 2026-08-25T02:00:00.000Z.');
  });

  it('offers the formats a query language and a person each need', () => {
    const chip = { t: 'date' as const, amount: 0, unit: 'day' as const, timezone: LA };
    expect(renderInstruction([{ ...chip, format: 'date' }], {}, now).text).toBe('2026-08-25');
    expect(renderInstruction([{ ...chip, format: 'datetime' }], {}, now).text).toBe(
      '2026-08-25 10:00 (UTC-07:00)'
    );
    // Default is the ISO instant a tool wants.
    expect(renderInstruction([chip], {}, now).text).toBe('2026-08-25T17:00:00.000Z');
  });

  it('snaps to the boundary of the unit when asked', () => {
    const start = renderInstruction(
      [{ t: 'date', amount: 0, unit: 'day', timezone: LA, boundary: 'start' }],
      {},
      now
    );
    expect(start.text).toBe('2026-08-25T07:00:00.000Z');
  });

  it('keeps a date chip out of the unbound-variable report', () => {
    const result = renderInstruction(
      [{ t: 'date', amount: -1, unit: 'day', timezone: LA }],
      {},
      now
    );
    expect(result.unbound).toEqual([]);
  });

  it('previews the intent, not a resolved instant', () => {
    expect(
      instructionPreview([{ t: 'date', amount: -1, unit: 'day', timezone: LA, atTime: '19:00' }])
    ).toBe('[yesterday 19:00 America/Los_Angeles]');
    expect(instructionPreview([{ t: 'date', amount: -3, unit: 'week', timezone: 'UTC' }])).toBe(
      '[3 weeks ago UTC]'
    );
  });

  it('says so in the prompt rather than inventing a date it could not resolve', () => {
    const { text } = renderInstruction(
      [{ t: 'date', amount: 0, unit: 'day', timezone: 'Pacific Time' }],
      {},
      now
    );
    expect(text).toContain('unresolved date');
  });
});

describe('describeFailureHandling', () => {
  const base = { outcome: 'not-found', action: 'exit' as const };

  it('renders each action faithfully — never a bare "stop" unless it IS exit', () => {
    expect(describeFailureHandling(base, 3)).toBe('on "not-found" stop the agent');
    expect(describeFailureHandling({ ...base, action: 'stop-quiet' }, 3)).toBe(
      'on "not-found" end quietly as skipped (declared not an error)'
    );
    expect(describeFailureHandling({ ...base, action: 'continue' }, 3, 'the ticket')).toBe(
      'on "not-found" keep going anyway (failure recorded, saved as "the ticket")'
    );
  });

  it('renders retry with its guidance and the after-every-try choice', () => {
    const text = describeFailureHandling(
      {
        outcome: 'no-results',
        action: 'retry',
        guidance: [{ t: 'text', v: 'Broaden the terms.' }],
        exhausted: 'continue',
      },
      5
    );
    expect(text).toBe(
      'on "no-results" retry (max 5 attempts) with: Broaden the terms.; if every try fails: keep going anyway'
    );
  });

  it('renders custom conditions with their when, and non-retry prose as a note', () => {
    const text = describeFailureHandling(
      {
        outcome: 'poor-match',
        action: 'continue',
        when: 'results exist but none match closely',
        guidance: [{ t: 'text', v: 'Note the best candidates.' }],
      },
      3
    );
    expect(text).toBe(
      'on "poor-match" (when: results exist but none match closely) keep going anyway ' +
        '(failure recorded) — note: Note the best candidates.'
    );
  });
});
