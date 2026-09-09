/**
 * What a step's prompt lists as known: the vars it references, the
 * builtins, and the live loop inputs — never everything bound so far.
 */

import { isAlwaysKnown, knownVariables } from './variables';

const variables = {
  today: '2026-09-09',
  'user.name': 'Scott',
  'trigger.text': 'Be on the lookout for a text.',
  'trigger.nearbyMessages': '[a very long dump]',
  'relevance context': 'CAS-24851',
  'final summary': 'a long summary',
  item: 'one',
  attempt: '2',
  'attempt.max': '3',
  'approval.outcome': 'approved',
};

describe('knownVariables', () => {
  it('lists builtins, referenced vars rendered by reference, and inputs — nothing else', () => {
    expect(
      knownVariables({
        variables,
        referenced: ['final summary', 'trigger.text'],
        inlined: ['trigger.text'],
        inputs: ['item'],
      })
    ).toEqual({
      today: '2026-09-09',
      'user.name': 'Scott',
      'final summary': 'a long summary',
      item: 'one',
      'approval.outcome': 'approved',
    });
  });

  it('never lists a trigger input or a saved result no chip names', () => {
    const known = knownVariables({ variables, referenced: [], inlined: [] });
    expect(known).not.toHaveProperty('trigger.nearbyMessages');
    expect(known).not.toHaveProperty('trigger.text');
    expect(known).not.toHaveProperty('relevance context');
    expect(known).toHaveProperty('today');
  });

  it('keeps the attempt chips out, even when referenced', () => {
    const known = knownVariables({
      variables,
      referenced: ['attempt', 'attempt.max'],
      inlined: [],
    });
    expect(known).not.toHaveProperty('attempt');
    expect(known).not.toHaveProperty('attempt.max');
  });
});

describe('isAlwaysKnown', () => {
  it('names the builtins and the answers bound for the step, not trigger inputs', () => {
    expect(isAlwaysKnown('today')).toBe(true);
    expect(isAlwaysKnown('user.email')).toBe(true);
    expect(isAlwaysKnown('question.answer')).toBe(true);
    expect(isAlwaysKnown('trigger.text')).toBe(false);
    expect(isAlwaysKnown('final summary')).toBe(false);
  });
});
