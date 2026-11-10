import {
  canSend,
  dialogShown,
  gbText,
  initSizeRequest,
  minWantedGb,
  requestBody,
  requestLine,
  sendLabel,
  sizeRequestReducer,
  type SizeRequestAction,
  type SizeRequestState,
} from './size-request.model';

const GB = 1_073_741_824;

function run(limitBytes: number, ...actions: SizeRequestAction[]): SizeRequestState {
  return actions.reduce(sizeRequestReducer, initSizeRequest(limitBytes));
}

describe('the checkout limit line', () => {
  it('says the limit in gigabytes, a fraction to one place', () => {
    expect(gbText(8 * GB)).toBe('8 GB');
    expect(gbText(1.5 * GB)).toBe('1.5 GB');
  });

  it('with no request yet, offers only the way to ask', () => {
    expect(requestLine(null)).toEqual({ kind: 'none' });
  });

  it('a waiting request replaces the way to ask', () => {
    expect(requestLine({ status: 'pending', requestedBytes: 24 * GB, decisionNote: null })).toEqual(
      { kind: 'pending', text: 'Your request for 24 GB is waiting for an admin.' }
    );
  });

  it('an approval says the size the admin approved', () => {
    expect(
      requestLine({ status: 'approved', requestedBytes: 20 * GB, decisionNote: null })
    ).toEqual({ kind: 'decided', text: 'Your request for 20 GB was approved.' });
  });

  it('a denial carries the admin’s note, or ends plainly without one', () => {
    expect(
      requestLine({
        status: 'denied',
        requestedBytes: 40 * GB,
        decisionNote: 'Prune build output first',
      })
    ).toEqual({ kind: 'decided', text: 'Your last request was denied: Prune build output first' });
    expect(requestLine({ status: 'denied', requestedBytes: 40 * GB, decisionNote: null })).toEqual({
      kind: 'decided',
      text: 'Your last request was denied.',
    });
  });
});

describe('the "Ask for more space" dialog', () => {
  it('is closed until the person asks, and Cancel closes it again', () => {
    expect(dialogShown(run(8 * GB), null)).toBe(false);
    expect(dialogShown(run(8 * GB, { type: 'opened' }), null)).toBe(true);
    expect(dialogShown(run(8 * GB, { type: 'opened' }, { type: 'closed' }), null)).toBe(false);
  });

  it('never shows while a request is waiting', () => {
    const pending = { status: 'pending' as const, requestedBytes: 24 * GB, decisionNote: null };
    expect(dialogShown(run(8 * GB, { type: 'opened' }), pending)).toBe(false);
  });

  it('starts at twice the current limit, and never past 64 GB', () => {
    expect(run(8 * GB).wanted).toBe(16);
    expect(run(40 * GB).wanted).toBe(64);
  });

  it('asks for at least a gigabyte more than the limit', () => {
    expect(minWantedGb(8 * GB)).toBe(9);
    expect(minWantedGb(1.5 * GB)).toBe(2);
  });

  it('Send is off until there is a reason, and a blank one does not count', () => {
    expect(canSend(run(8 * GB, { type: 'opened' }))).toBe(false);
    expect(canSend(run(8 * GB, { type: 'reasonChanged', reason: '   ' }))).toBe(false);
    expect(canSend(run(8 * GB, { type: 'reasonChanged', reason: 'Monorepo' }))).toBe(true);
  });

  it('sends the size in bytes and the reason', () => {
    const state = run(
      8 * GB,
      { type: 'opened' },
      { type: 'wantedChanged', gb: 24 },
      { type: 'reasonChanged', reason: 'Monorepo with vendored toolchains' }
    );
    expect(requestBody(state)).toEqual({
      requestedBytes: 24 * GB,
      reason: 'Monorepo with vendored toolchains',
    });
  });

  it('while sending, Send is off and reads "Sending…"', () => {
    const state = run(8 * GB, { type: 'reasonChanged', reason: 'Monorepo' }, { type: 'sent' });
    expect(canSend(state)).toBe(false);
    expect(sendLabel(state)).toBe('Sending…');
  });

  it('an accepted request closes the dialog and forgets the reason', () => {
    const state = run(
      8 * GB,
      { type: 'opened' },
      { type: 'reasonChanged', reason: 'Monorepo' },
      { type: 'sent' },
      { type: 'accepted' }
    );
    expect(state.open).toBe(false);
    expect(state.reason).toBe('');
    expect(sendLabel(state)).toBe('Send request');
  });

  it('a refused request keeps the dialog open with the server’s words, ready to send again', () => {
    const state = run(
      8 * GB,
      { type: 'opened' },
      { type: 'reasonChanged', reason: 'again' },
      { type: 'sent' },
      { type: 'failed', error: 'A request for this project is already waiting' }
    );
    expect(state.open).toBe(true);
    expect(state.error).toBe('A request for this project is already waiting');
    expect(canSend(state)).toBe(true);
    expect(sizeRequestReducer(state, { type: 'sent' }).error).toBeNull();
  });
});
