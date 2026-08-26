/**
 * The outcome enumeration's load-bearing promises: every set ends in a
 * catch-all, codes never collide within a tool, and resolution prefers the
 * registration site over the curated seed over the generic default —
 * because saved agents key their failure handling on these codes, and a
 * source that silently shadowed another would re-route someone's handling.
 */

import {
  CURATED_OUTCOMES,
  GENERIC_FAILURES,
  OTHER_FAILURE,
  genericOutcomes,
  outcomeError,
  OUTCOME_META_KEY,
  resolveOutcomes,
} from './outcomes';

describe('genericOutcomes', () => {
  it('always ends in the catch-all', () => {
    for (const kind of ['read', 'act'] as const) {
      const { failures } = genericOutcomes(kind);
      expect(failures[failures.length - 1]?.code).toBe(OTHER_FAILURE.code);
    }
  });

  it('phrases success for the kind of tool', () => {
    expect(genericOutcomes('read').success.label).not.toEqual(genericOutcomes('act').success.label);
  });
});

describe('CURATED_OUTCOMES', () => {
  it('has unique codes within each tool', () => {
    for (const [tool, outcomes] of Object.entries(CURATED_OUTCOMES)) {
      const codes = outcomes.failures.map((f) => f.code);
      expect(new Set(codes).size).toBe(codes.length);
      // Context for a failure: which tool broke the invariant.
      if (new Set(codes).size !== codes.length) throw new Error(tool);
    }
  });

  it('keeps the generic conditions alongside the specific ones', () => {
    // The builder promises "here are the ways this can fail" — a curated
    // entry narrows nothing, it only adds.
    for (const outcomes of Object.values(CURATED_OUTCOMES)) {
      const codes = new Set(outcomes.failures.map((f) => f.code));
      for (const generic of GENERIC_FAILURES) {
        expect(codes.has(generic.code)).toBe(true);
      }
      expect(codes.has(OTHER_FAILURE.code)).toBe(true);
    }
  });
});

describe('resolveOutcomes', () => {
  it('falls back to generic for an unknown tool', () => {
    const outcomes = resolveOutcomes('zoom_get_meeting', 'read');
    expect(outcomes.failures.map((f) => f.code)).toEqual([
      ...GENERIC_FAILURES.map((f) => f.code),
      OTHER_FAILURE.code,
    ]);
  });

  it('prefers the curated seed over generic', () => {
    const outcomes = resolveOutcomes('jira_create_issue', 'act');
    expect(outcomes.failures.map((f) => f.code)).toContain('project-not-found');
  });

  it('prefers a registration-site declaration over the curated seed', () => {
    const declared = {
      outcomes: {
        success: { label: 'It worked' },
        failures: [
          {
            code: 'custom-condition',
            label: 'Custom thing happened',
            description: 'A condition only this tool knows about.',
            retriable: true,
          },
        ],
      },
    };
    const outcomes = resolveOutcomes('jira_create_issue', 'act', declared);
    expect(outcomes.success.label).toBe('It worked');
    expect(outcomes.failures.map((f) => f.code)).toEqual(['custom-condition', 'other']);
  });

  it('ignores a malformed declaration rather than serving half a shape', () => {
    const outcomes = resolveOutcomes('jira_create_issue', 'act', {
      outcomes: { success: {}, failures: [{ code: 'missing-everything-else' }] },
    });
    // Falls through to the curated entry.
    expect(outcomes.failures.map((f) => f.code)).toContain('project-not-found');
  });

  it('appends the catch-all to declared sets that lack one', () => {
    const outcomes = resolveOutcomes('anything', 'read', {
      outcomes: { success: { label: 'ok' }, failures: [] },
    });
    expect(outcomes.failures.map((f) => f.code)).toEqual(['other']);
  });
});

describe('outcomeError', () => {
  it('names its condition where the runtime reads it', () => {
    const result = outcomeError('not-found', 'PROJ-999 does not exist');
    expect(result.isError).toBe(true);
    expect(result._meta[OUTCOME_META_KEY]).toBe('not-found');
    expect(result.content[0]?.text).toBe('PROJ-999 does not exist');
  });
});
