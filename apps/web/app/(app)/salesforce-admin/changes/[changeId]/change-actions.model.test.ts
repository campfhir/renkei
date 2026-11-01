/**
 * A Salesforce admin change request's actions, by who is looking and what
 * the request is: an operator approves or declines with a note, someone
 * else withdraws their own, a request in words has nothing to approve,
 * and a refusal shows the route's words. These were the button checks in
 * salesforce-admin.spec.ts.
 */

import {
  actionUrl,
  changeActionsReducer,
  changeActionsView,
  failureMessage,
  initialChangeActions,
  requestBody,
  type ChangeActionsEvent,
  type ChangeActionsProps,
  type ChangeActionsState,
} from './change-actions.model';

const OPERATOR: ChangeActionsProps = {
  orgName: 'UAT',
  applyBlocked: null,
  canApprove: true,
  isOwner: false,
};
const ASKER: ChangeActionsProps = {
  orgName: 'UAT',
  applyBlocked: null,
  canApprove: false,
  isOwner: true,
};

const after = (...events: ChangeActionsEvent[]): ChangeActionsState =>
  events.reduce(changeActionsReducer, initialChangeActions);

describe('an operator on a proposal', () => {
  it('may approve and deploy, or decline', () => {
    const view = changeActionsView(OPERATOR, initialChangeActions);
    expect(view.approve).toEqual({ label: 'Approve and deploy to UAT', disabled: false });
    expect(view.decline).toEqual({ disabled: false });
    expect(view.send).toBeNull();
    expect(view.waitsForOperator).toBe(false);
    expect(view.noteField).toBe(false);
  });

  it('approves and applies a change that is only data', () => {
    expect(
      changeActionsView({ ...OPERATOR, dataOnly: true }, initialChangeActions).approve?.label
    ).toBe('Approve and apply in UAT');
  });

  it('sees why approving is refused, with the button off', () => {
    const view = changeActionsView(
      { ...OPERATOR, applyBlocked: 'Salesforce’s check failed.' },
      initialChangeActions
    );
    expect(view.blocked).toBe('Salesforce’s check failed.');
    expect(view.approve?.disabled).toBe(true);
    expect(view.decline?.disabled).toBe(false);
  });

  it('declining opens a note for the requester, and Send the decline carries it', () => {
    const state = after({ type: 'startDecline' }, { type: 'noteChanged', note: 'Not this sprint' });
    const view = changeActionsView(OPERATOR, state);
    expect(view.noteField).toBe(true);
    expect(view.decline).toBeNull();
    expect(view.send).toEqual({ label: 'Send the decline', disabled: false });
    expect(requestBody('cancel', state)).toEqual({ note: 'Not this sprint' });
  });

  it('approving sends nothing about the change, only which one', () => {
    expect(requestBody('apply', after({ type: 'noteChanged', note: 'ignored' }))).toEqual({});
    expect(actionUrl('c-1', 'apply')).toBe('/api/salesforce-admin/changes/c-1/apply');
    expect(actionUrl('c-1', 'cancel')).toBe('/api/salesforce-admin/changes/c-1/cancel');
  });

  it('while approving, the button says so and nothing else can be pressed', () => {
    const view = changeActionsView(OPERATOR, after({ type: 'sent', action: 'apply' }));
    expect(view.approve).toEqual({ label: 'Approving…', disabled: true });
    expect(view.decline?.disabled).toBe(true);
  });

  it('once approved it is queued, and every button stays off', () => {
    const state = after({ type: 'sent', action: 'apply' }, { type: 'succeeded', action: 'apply' });
    expect(state.queued).toBe(true);
    const view = changeActionsView(OPERATOR, state);
    expect(view.approve).toEqual({ label: 'Approve and deploy to UAT', disabled: true });
    expect(view.decline?.disabled).toBe(true);
  });

  it('a sent decline does not count as approved', () => {
    const state = after(
      { type: 'startDecline' },
      { type: 'sent', action: 'cancel' },
      { type: 'succeeded', action: 'cancel' }
    );
    expect(state.queued).toBe(false);
    expect(state.busy).toBeNull();
  });
});

describe('an operator on a request in words', () => {
  it('has nothing to approve — only to decline — and no blocked notice', () => {
    const view = changeActionsView(
      { ...OPERATOR, isRequest: true, applyBlocked: 'Nothing to validate' },
      initialChangeActions
    );
    expect(view.approve).toBeNull();
    expect(view.blocked).toBeNull();
    expect(view.decline).toEqual({ disabled: false });
  });
});

describe('the person who asked', () => {
  it('may only withdraw it, and is told an operator decides', () => {
    const view = changeActionsView(ASKER, initialChangeActions);
    expect(view.approve).toBeNull();
    expect(view.decline).toBeNull();
    expect(view.send).toEqual({ label: 'Withdraw it', disabled: false });
    expect(view.waitsForOperator).toBe(true);
  });

  it('sees no blocked notice meant for operators', () => {
    expect(
      changeActionsView({ ...ASKER, applyBlocked: 'Read only' }, initialChangeActions).blocked
    ).toBeNull();
  });

  it('while withdrawing, the button says Cancelling…', () => {
    expect(changeActionsView(ASKER, after({ type: 'sent', action: 'cancel' })).send).toEqual({
      label: 'Cancelling…',
      disabled: true,
    });
  });
});

describe('someone else’s request, without approving rights', () => {
  it('offers no action at all', () => {
    const view = changeActionsView({ ...ASKER, isOwner: false }, initialChangeActions);
    expect([view.approve, view.decline, view.send]).toEqual([null, null, null]);
    expect(view.waitsForOperator).toBe(true);
  });
});

describe('a refusal', () => {
  it('shows the route’s own words and frees the buttons', () => {
    const state = after(
      { type: 'sent', action: 'apply' },
      {
        type: 'failed',
        message: failureMessage('apply', { error: 'This change request was cancelled.' }),
      }
    );
    expect(state).toMatchObject({ busy: null, notice: 'This change request was cancelled.' });
    expect(changeActionsView(OPERATOR, state).approve?.disabled).toBe(false);
  });

  it('falls back to plain words when the route gives none', () => {
    expect(failureMessage('apply', {})).toBe('Could not approve the change');
    expect(failureMessage('cancel', null)).toBe('Could not cancel the change');
    expect(failureMessage('cancel', { error: '' })).toBe('Could not cancel the change');
    expect(failureMessage('apply', ['error'])).toBe('Could not approve the change');
  });

  it('is cleared when the next action goes out', () => {
    const state = after({ type: 'failed', message: 'Nope' }, { type: 'sent', action: 'cancel' });
    expect(state.notice).toBeNull();
  });
});
