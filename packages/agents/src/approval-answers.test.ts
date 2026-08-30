/**
 * What a form card accepts back — the rule set the card, the web route and
 * the MCP tool all run. What is pinned here is the line between "the shape
 * is wrong" (refused here) and "the value is wrong" (the agent's problem):
 * a number that is not a number never reaches a step, and a wrong issue key
 * always does.
 */

import {
  approvalAnswerText,
  checkApprovalAnswers,
  describeApprovalAnswer,
} from './approval-answers';
import type { ApprovalField } from './steps';

const field = (
  name: string,
  over: Partial<ApprovalField> & Pick<ApprovalField, 'type'>
): ApprovalField => ({
  name,
  label: over.label ?? `Field ${name}`,
  required: over.required ?? false,
  ...over,
});

describe('checkApprovalAnswers', () => {
  it('requires what is required, and is content with a blank optional', () => {
    const fields = [
      field('a', { type: 'text', required: true }),
      field('b', { type: 'text', required: false }),
    ];

    const missing = checkApprovalAnswers(fields, { b: 'something' });
    expect(missing.ok).toBe(false);
    expect(missing.issues).toEqual([{ name: 'a', label: 'Field a', message: 'Needs an answer.' }]);

    const given = checkApprovalAnswers(fields, { a: '  CIO-12 ', b: '' });
    expect(given.ok).toBe(true);
    // Trimmed, and an empty optional binds nothing rather than binding ''.
    expect(given.values).toEqual({ a: 'CIO-12' });
  });

  it('holds a number to being a number, and to its bounds', () => {
    const fields = [field('n', { type: 'number', required: true, min: 1, max: 13 })];

    expect(checkApprovalAnswers(fields, { n: 'eight' }).issues[0]?.message).toBe(
      'Must be a number.'
    );
    expect(checkApprovalAnswers(fields, { n: '0' }).issues[0]?.message).toBe('Must be 1 or more.');
    expect(checkApprovalAnswers(fields, { n: '21' }).issues[0]?.message).toBe(
      'Must be 13 or less.'
    );

    // Whitespace and a numeric type both land on the same canonical string.
    expect(checkApprovalAnswers(fields, { n: ' 8 ' }).values).toEqual({ n: '8' });
    expect(checkApprovalAnswers(fields, { n: 8 }).values).toEqual({ n: '8' });
  });

  it('only accepts choices that were offered', () => {
    const one = [field('c', { type: 'choice', required: true, options: ['yes', 'no'] })];
    expect(checkApprovalAnswers(one, { c: 'maybe' }).ok).toBe(false);
    expect(checkApprovalAnswers(one, { c: 'no' }).values).toEqual({ c: 'no' });

    const many = [field('m', { type: 'multi', required: true, options: ['a', 'b', 'c'] })];
    expect(checkApprovalAnswers(many, { m: ['a', 'z'] }).ok).toBe(false);
    expect(checkApprovalAnswers(many, { m: [] }).issues[0]?.message).toBe('Pick at least one.');
    // Duplicates collapse: two clicks of one checkbox is one pick.
    expect(checkApprovalAnswers(many, { m: ['a', 'b', 'a'] }).values).toEqual({ m: ['a', 'b'] });
  });

  it('takes a real calendar date only', () => {
    const fields = [field('d', { type: 'date', required: true })];
    expect(checkApprovalAnswers(fields, { d: '14/09/2026' }).ok).toBe(false);
    expect(checkApprovalAnswers(fields, { d: '2026-02-31' }).ok).toBe(false);
    expect(checkApprovalAnswers(fields, { d: '2026-09-14' }).values).toEqual({ d: '2026-09-14' });
  });

  it('ignores keys the form does not know rather than refusing the lot', () => {
    // A card rendered before its step was edited posts what it had. Losing
    // someone's typing over an author's edit is the worse failure.
    const fields = [field('a', { type: 'text', required: true })];
    const result = checkApprovalAnswers(fields, { a: 'kept', 'deleted-field': 'dropped' });
    expect(result.ok).toBe(true);
    expect(result.values).toEqual({ a: 'kept' });
  });

  it('describes an answer with the destination id beside it, where there is one', () => {
    // The pair is the point: a step writing to Jira needs customfield_10016
    // AND the 8, not a display name it would have to resolve at run time.
    expect(
      describeApprovalAnswer(
        field('the points', { type: 'number', label: 'Story Points', key: 'customfield_10016' }),
        '8'
      )
    ).toBe('Story Points [customfield_10016]: 8');

    // No destination, no brackets — most fields are just an answer.
    expect(
      describeApprovalAnswer(field('the picks', { type: 'multi', label: 'Comments' }), ['a', 'b'])
    ).toBe('Comments: a, b');
  });

  it('renders a multi-select the way a collected list renders', () => {
    expect(approvalAnswerText(['one', 'two'])).toBe('one\ntwo');
    expect(approvalAnswerText('plain')).toBe('plain');
  });
});
