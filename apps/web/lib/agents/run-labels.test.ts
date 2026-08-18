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
  ])('titles %s', (raw, label) => {
    expect(statusLabel(raw)).toBe(label);
  });

  it('capitalizes an unknown status rather than hiding it', () => {
    expect(statusLabel('paused')).toBe('Paused');
  });
});

describe('errorSummary', () => {
  it('names the failed step when the name is known', () => {
    expect(errorSummary('step_failed', 'File Jira tickets')).toBe(
      'Failed on step: File Jira tickets'
    );
  });

  it('still reads as a sentence when the step name is unresolvable', () => {
    expect(errorSummary('step_failed', null)).toBe('A step failed');
  });

  it.each([
    ['config', 'Setup problem'],
    ['timeout', 'Ran out of time'],
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
