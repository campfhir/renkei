/**
 * Accepting or declining an approval card on the home feed: what is sent,
 * and what each answer leaves on the card.
 */

import {
  approvalOutcome,
  approvalReducer,
  approvalRequest,
  initialApproval,
  type ApprovalAction,
} from './approval-actions.model';

const run = (actions: ApprovalAction[]) => actions.reduce(approvalReducer, initialApproval);

it('sends the decision with the note for the agent, trimmed', () => {
  expect(approvalRequest('approve', '  not this project — use OPS \n')).toEqual({
    decision: 'approve',
    comment: 'not this project — use OPS',
  });
  expect(approvalRequest('decline', '')).toEqual({ decision: 'decline', comment: '' });
});

it('both buttons are off while the decision is on its way', () => {
  expect(run([{ type: 'sent' }]).busy).toBe(true);
});

it('a decision that lands leaves no message (the feed refreshes)', () => {
  const state = run([{ type: 'sent' }, { type: 'answered', outcome: approvalOutcome(200, {}) }]);
  expect(state).toMatchObject({ busy: false, notice: null, error: null });
});

it('a recorded decision whose run resumes late shows the warning, not an error', () => {
  const outcome = approvalOutcome(502, { warning: 'Recorded; the run resumes shortly.' });
  expect(outcome).toEqual({ kind: 'delayed', warning: 'Recorded; the run resumes shortly.' });
  const state = run([{ type: 'sent' }, { type: 'answered', outcome }]);
  expect(state).toMatchObject({ notice: 'Recorded; the run resumes shortly.', error: null });
});

it('a refused decision shows why, keeping the note to try again', () => {
  const state = run([
    { type: 'commentChanged', value: 'use OPS' },
    { type: 'sent' },
    { type: 'answered', outcome: approvalOutcome(409, { error: 'Already decided.' }) },
  ]);
  expect(state).toMatchObject({ busy: false, error: 'Already decided.', comment: 'use OPS' });
});

it('a refusal without words, or a 502 without a warning, says the status', () => {
  expect(approvalOutcome(500, null)).toEqual({ kind: 'refused', error: 'Request failed (500)' });
  expect(approvalOutcome(502, {})).toEqual({ kind: 'refused', error: 'Request failed (502)' });
});

it('trying again clears the last message', () => {
  const state = run([
    { type: 'answered', outcome: { kind: 'refused', error: 'No.' } },
    { type: 'sent' },
  ]);
  expect(state.error).toBeNull();
});

it('a server it cannot reach says so and lets the person try again', () => {
  expect(run([{ type: 'sent' }, { type: 'unreachable' }])).toMatchObject({
    busy: false,
    error: 'Could not reach the server.',
  });
});
