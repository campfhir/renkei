/**
 * The Disconnect control at the foot of a connect card, as the person
 * pressing it sees it. Moved from e2e/connectors.spec.ts ("Keep it" must
 * not disconnect; "Yes, disconnect" does).
 */

import {
  confirmLabel,
  disconnectReducer,
  disconnectRefusal,
  initialDisconnectState,
  type DisconnectAction,
  type DisconnectState,
} from './disconnect-control.model';

const after = (...actions: DisconnectAction[]): DisconnectState =>
  actions.reduce(disconnectReducer, initialDisconnectState);

describe('the disconnect control', () => {
  it('starts as a plain Disconnect button', () => {
    expect(after()).toEqual({ confirming: false, busy: false, notice: null });
  });

  it('Disconnect asks first', () => {
    expect(after({ type: 'asked' }).confirming).toBe(true);
  });

  it('"Keep it" backs out without sending anything', () => {
    expect(after({ type: 'asked' }, { type: 'kept' })).toEqual(initialDisconnectState);
  });

  it('"Yes, disconnect" is busy while the call is out', () => {
    const state = after({ type: 'asked' }, { type: 'sent' });
    expect(state.busy).toBe(true);
    expect(confirmLabel(state)).toBe('Disconnecting…');
    expect(confirmLabel(after({ type: 'asked' }))).toBe('Yes, disconnect');
  });

  it('a disconnect that lands closes the confirmation', () => {
    expect(after({ type: 'asked' }, { type: 'sent' }, { type: 'disconnected' })).toEqual(
      initialDisconnectState
    );
  });

  it('a refused disconnect keeps the confirmation open and shows why', () => {
    const state = after(
      { type: 'asked' },
      { type: 'sent' },
      { type: 'failed', notice: 'Could not disconnect' }
    );
    expect(state).toEqual({ confirming: true, busy: false, notice: 'Could not disconnect' });
  });

  it('trying again clears the last refusal', () => {
    const state = after(
      { type: 'asked' },
      { type: 'sent' },
      { type: 'failed', notice: 'No' },
      { type: 'sent' }
    );
    expect(state.notice).toBeNull();
  });

  it("a refusal shows the server's own words from the first field that has them", () => {
    expect(disconnectRefusal({ error: 'Token revoked elsewhere' }, ['error'])).toBe(
      'Token revoked elsewhere'
    );
    expect(disconnectRefusal({ error: '', message: 'Jira said no' }, ['error', 'message'])).toBe(
      'Jira said no'
    );
  });

  it('a refusal without words says "Could not disconnect"', () => {
    expect(disconnectRefusal({}, ['error'])).toBe('Could not disconnect');
    expect(disconnectRefusal({ error: 42 }, ['error'])).toBe('Could not disconnect');
    expect(disconnectRefusal(null, ['error'])).toBe('Could not disconnect');
    expect(disconnectRefusal(['error'], ['error'])).toBe('Could not disconnect');
  });
});
