/**
 * Wording for run records — pure functions, so the tests pin the contract:
 * every kind the engine actually writes has a phrase, and unknown values
 * pass through instead of vanishing.
 */

import { statusLabel, errorSummary, outcomeCodeLabel, statusNote, statusTone } from './run-labels';

describe('statusLabel', () => {
  it.each([
    ['queued', 'Queued'],
    ['running', 'Running'],
    ['succeeded', 'Succeeded'],
    ['failed', 'Failed'],
    ['canceled', 'Canceled'],
    ['stopped', 'Skipped'],
  ])('titles %s', (raw, label) => {
    expect(statusLabel(raw)).toBe(label);
  });

  it('reads a retired attempt as set aside — a resume’s doing, not a failure the run ignored', () => {
    expect(statusLabel('retired')).toBe('Set aside');
  });

  it('capitalizes an unknown status rather than hiding it', () => {
    expect(statusLabel('paused')).toBe('Paused');
  });
});

describe('errorSummary', () => {
  it('still reads a run from the step era', () => {
    expect(errorSummary('step_failed')).toBe('A step failed');
  });

  it.each([
    ['agent_failed', 'The agent could not reach its goal'],
    ['config', 'Setup problem'],
    ['timeout', 'Used its active time'],
    ['budget', 'Used its tool-call budget'],
    ['llm_auth', 'AI model sign-in problem'],
    ['llm_error', 'AI model error'],
  ])('translates %s — every kind the engine writes', (kind, phrase) => {
    expect(errorSummary(kind)).toBe(phrase);
  });

  it('passes an unknown kind through raw — never hide a truth', () => {
    expect(errorSummary('meteor_strike')).toBe('meteor_strike');
  });
});

describe('outcomeCodeLabel', () => {
  it('uses the generic catalog labels', () => {
    expect(outcomeCodeLabel('not-found')).toBe("The item couldn't be found");
    expect(outcomeCodeLabel('other')).toBe('Anything else goes wrong');
  });

  it('covers curated per-tool codes too', () => {
    expect(outcomeCodeLabel('project-not-found')).toBe("The project couldn't be found");
  });

  it('passes unknown codes through', () => {
    expect(outcomeCodeLabel('mystery-code')).toBe('mystery-code');
  });
});

describe('a run halted while stuck', () => {
  it('reads Halted on its pill instead of Canceled', () => {
    expect(statusLabel('canceled', 'force_halted')).toBe('Halted');
    expect(statusLabel('canceled', null)).toBe('Canceled');
  });

  it('takes a pill colour of its own, apart from a plain cancel', () => {
    expect(statusTone('canceled', 'force_halted')).toBe('halted');
    expect(statusTone('canceled', null)).toBe('canceled');
    expect(statusTone('failed', 'timeout')).toBe('failed');
  });

  it('needs no line under its pill: the pill already says it', () => {
    expect(statusNote('canceled', 'force_halted')).toBeNull();
    expect(errorSummary('force_halted')).toBe('Halted while stuck');
  });

  it('a failure still gets its reason under the pill, and a clean run nothing', () => {
    expect(statusNote('failed', 'timeout')).toBe('Used its active time');
    expect(statusNote('succeeded', null)).toBeNull();
  });
});
