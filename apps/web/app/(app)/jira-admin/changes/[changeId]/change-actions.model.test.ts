/**
 * A Jira admin change request's actions, by who is looking and what the
 * request is: an operator approves (the button counts the steps) or
 * declines with a note, an operator whose connection cannot apply it sees
 * why with Approve off, someone else withdraws their own, a request in
 * words has nothing to approve, and a refusal (another Jira site, a
 * request no longer waiting) shows the route's words. These were the
 * button checks in the jira-admin-* specs.
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
  count: 4,
  applyBlocked: null,
  canApprove: true,
  isOwner: true,
};
const ASKER: ChangeActionsProps = {
  count: 4,
  applyBlocked: null,
  canApprove: false,
  isOwner: true,
};

const after = (...events: ChangeActionsEvent[]): ChangeActionsState =>
  events.reduce(changeActionsReducer, initialChangeActions);

describe('an operator on a proposal', () => {
  it('may approve and apply every step, or decline', () => {
    const view = changeActionsView(OPERATOR, initialChangeActions);
    expect(view.approve).toEqual({
      label: 'Approve and apply these 4 changes to Jira',
      disabled: false,
    });
    expect(view.decline).toEqual({ disabled: false });
    expect(view.send).toBeNull();
    expect(view.waitsForOperator).toBe(false);
    expect(view.noteField).toBe(false);
  });

  it('says “this change” for a proposal of one step', () => {
    expect(changeActionsView({ ...OPERATOR, count: 1 }, initialChangeActions).approve?.label).toBe(
      'Approve and apply this change to Jira'
    );
  });

  it('a connection without the scope the writes need: says why, with Approve off', () => {
    const why =
      'Your Jira Administration connection does not include manage:jira-configuration. Reconnect it with that box ticked.';
    const view = changeActionsView({ ...OPERATOR, applyBlocked: why }, initialChangeActions);
    expect(view.blocked).toBe(why);
    expect(view.approve?.disabled).toBe(true);
    // Declining needs no connection.
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
    expect(actionUrl('c-1', 'apply')).toBe('/api/jira-admin/changes/c-1/apply');
    expect(actionUrl('c-1', 'cancel')).toBe('/api/jira-admin/changes/c-1/cancel');
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
    expect(view.approve).toEqual({
      label: 'Approve and apply these 4 changes to Jira',
      disabled: true,
    });
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
      { ...OPERATOR, isRequest: true, applyBlocked: 'Not connected' },
      initialChangeActions
    );
    expect(view.approve).toBeNull();
    expect(view.blocked).toBeNull();
    expect(view.decline).toEqual({ disabled: false });
  });
});

describe('the person who asked, without approving rights', () => {
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
  it('shows the route’s own words — another Jira site — and frees the buttons', () => {
    const state = after(
      { type: 'sent', action: 'apply' },
      {
        type: 'failed',
        message: failureMessage('apply', {
          error:
            'Your Jira Administration connection is on a different Jira site than the one this change was proposed for.',
        }),
      }
    );
    expect(state.busy).toBeNull();
    expect(state.notice).toMatch(/different Jira site/);
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
