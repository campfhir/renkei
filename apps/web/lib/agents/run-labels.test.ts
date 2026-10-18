/**
 * Wording for run records — pure functions, so the tests pin the contract:
 * every kind the engine actually writes has a phrase, and unknown values
 * pass through instead of vanishing.
 */

import { statusLabel, errorSummary, outcomeCodeLabel } from './run-labels';

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
