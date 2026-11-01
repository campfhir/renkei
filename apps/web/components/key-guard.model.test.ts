/**
 * The key dialog (key-guard.model.ts): which of the person's key moments
 * is on screen and what each answer leaves there. keys.spec.ts walked
 * these through a browser (the dismissable dialog and its banner, a typed
 * key refused then taken, "Not now" on the trust dialog, then Review);
 * it keeps real enrollment, one typed key, one trust confirmation and the
 * phone-width fit.
 */

import type { KeyStatusView } from '@/lib/keys/shared';
import type { DeviceAsk, FlowFailure } from '@/lib/keys/browser/flows';
import {
  approvalRechecks,
  canApprove,
  canSubmitPassphrase,
  canSubmitTypedKey,
  checkStep,
  codeFor,
  delegationStops,
  dialogOpen,
  initialKeyGuard,
  keyGuardReducer,
  renewDue,
  statusUsable,
  trustBannerFor,
  type KeyGuardAction,
  type KeyGuardState,
} from './key-guard.model';

const NOW = Date.parse('2026-06-01T12:00:00.000Z');
const DAY = 24 * 60 * 60_000;
const SHOWN = 'abcd-efgh-ijkl-mnop-qrst-uvwx-yz23-4567-abcd-efgh-ijkl-mnop-qrst-uvwx';
const UNKNOWN = [{ id: 'i-9', publicKey: 'cGxhbnRlZA==', fingerprint: 'ABCDE-FGHIJ' }];
const UNTRUSTED: FlowFailure = {
  code: 'untrusted_instances',
  error: 'Confirm the key service first.',
  unknown: UNKNOWN,
};
const WRONG_KEY: FlowFailure = {
  code: 'wrong_key',
  error: 'That is not the key for this account.',
};
const ASKING = [{ id: 'req-1', createdAt: '2026-06-01T11:59:00.000Z', userAgent: null }];
const ASK: DeviceAsk = {
  id: 'ask-1',
  code: 'QWERT-YUIOP',
  privateKey: new Uint8Array(32),
  publicKey: new Uint8Array(32),
};

function status(overrides: Partial<KeyStatusView> = {}): KeyStatusView {
  return {
    enrolled: true,
    legacy: false,
    legacyNeedsPassphrase: false,
    publicKey: 'pk',
    wrappedPrivateKey: 'wp',
    wrappedAutomationKey: 'wa',
    version: 1,
    enrolledAt: '2026-05-01T00:00:00.000Z',
    instances: [{ id: 'i-1', publicKey: 'k1' }],
    instanceSigningKey: null,
    instancesSignature: null,
    sessionDelegated: true,
    instancesMissingSession: [],
    automationInstances: ['i-1'],
    automationUntil: new Date(NOW + 25 * DAY).toISOString(),
    automationDays: 30,
    pendingDevices: [],
    unavailable: false,
    ...overrides,
  };
}

const fold = (actions: KeyGuardAction[], from: KeyGuardState = initialKeyGuard) =>
  actions.reduce(keyGuardReducer, from);

const needsKey = fold([{ type: 'device-without-key', sessionDelegated: false }]);

describe('what a check does', () => {
  it('waits while the key service cannot be reached', () => {
    expect(statusUsable(null)).toBe(false);
    expect(statusUsable(status({ unavailable: true }))).toBe(false);
    expect(statusUsable(status())).toBe(true);
    expect(fold([{ type: 'status-unavailable' }]).banner).toEqual({ kind: 'unavailable' });
  });

  it('keeps the shown-once key on screen even when the key service drops out', () => {
    const state = fold([
      { type: 'enroll-answered', answer: { ok: true, shown: SHOWN } },
      { type: 'status-unavailable' },
    ]);
    expect(state.banner).toEqual({ kind: 'write-down', shown: SHOWN });
  });

  it('a first sign-in enrolls without asking; a passphrase-protected earlier key asks for it first', () => {
    expect(checkStep(status({ enrolled: false }), false, NOW)).toEqual({ kind: 'enroll' });
    expect(checkStep(status({ enrolled: false, legacy: true }), false, NOW)).toEqual({
      kind: 'enroll',
    });
    expect(
      checkStep(status({ enrolled: false, legacy: true, legacyNeedsPassphrase: true }), false, NOW)
    ).toEqual({ kind: 'passphrase' });
    expect(fold([{ type: 'passphrase-needed' }]).banner).toEqual({ kind: 'passphrase' });
  });

  it('an enrollment shows the key once; a refused one says why under the unavailable banner', () => {
    expect(fold([{ type: 'enroll-answered', answer: { ok: true, shown: SHOWN } }]).banner).toEqual({
      kind: 'write-down',
      shown: SHOWN,
    });
    const refused = fold([
      {
        type: 'enroll-answered',
        answer: { ok: false, failure: { code: 'no_instances', error: 'No key service.' } },
      },
    ]);
    expect(refused.banner).toEqual({ kind: 'unavailable' });
    expect(refused.failure).toBe('No key service.');
  });

  it('an enrollment to a key service this browser has not met asks for the fingerprint first', () => {
    const state = fold([{ type: 'enroll-answered', answer: { ok: false, failure: UNTRUSTED } }]);
    expect(state.banner).toEqual({ kind: 'trust', unknown: UNKNOWN });
    expect(state.failure).toBeNull();
  });

  it('with the key on this device, a lost delegation is sealed again', () => {
    expect(checkStep(status({ sessionDelegated: false }), true, NOW)).toEqual({
      kind: 'device',
      delegate: true,
      renew: false,
    });
    expect(checkStep(status(), true, NOW)).toEqual({
      kind: 'device',
      delegate: false,
      renew: false,
    });
  });

  it('renews the agents’ window once half of it has passed', () => {
    const halfGone = status({ automationUntil: new Date(NOW + 14 * DAY).toISOString() });
    expect(renewDue(halfGone, NOW)).toBe(true);
    expect(renewDue(status(), NOW)).toBe(false);
    expect(renewDue(status({ automationUntil: null }), NOW)).toBe(false);
    expect(checkStep(halfGone, true, NOW)).toEqual({
      kind: 'device',
      delegate: false,
      renew: true,
    });
  });

  it('a re-seal refused for a key service to confirm, or a key rotated elsewhere, stops the check', () => {
    expect(delegationStops({ ok: true })).toBe(false);
    expect(delegationStops({ ok: false, failure: UNTRUSTED })).toBe(true);
    expect(delegationStops({ ok: false, failure: WRONG_KEY })).toBe(true);
    expect(delegationStops({ ok: false, failure: { code: 'http_500', error: 'x' } })).toBe(false);
    expect(
      fold([{ type: 'delegate-answered', answer: { ok: false, failure: WRONG_KEY } }]).banner
    ).toEqual({ kind: 'needs-key' });
    expect(
      fold([{ type: 'delegate-answered', answer: { ok: false, failure: UNTRUSTED } }]).banner
    ).toEqual({ kind: 'trust', unknown: UNKNOWN });
    expect(fold([{ type: 'delegate-answered', answer: { ok: true } }])).toEqual(initialKeyGuard);
  });

  it('then another device asking comes first, then a key never written down, else nothing', () => {
    expect(
      fold([{ type: 'device-checked', pendingDevices: ASKING, acknowledged: false, shown: SHOWN }])
        .banner
    ).toEqual({ kind: 'approve', requests: ASKING });
    expect(
      fold([{ type: 'device-checked', pendingDevices: [], acknowledged: false, shown: SHOWN }])
        .banner
    ).toEqual({ kind: 'write-down', shown: SHOWN });
    expect(
      fold([{ type: 'device-checked', pendingDevices: [], acknowledged: true, shown: SHOWN }])
        .banner
    ).toEqual({ kind: 'none' });
  });

  it('a device without the key is fine while another browser delegated this session', () => {
    expect(checkStep(status(), false, NOW)).toEqual({ kind: 'no-device-key' });
    expect(fold([{ type: 'device-without-key', sessionDelegated: true }]).banner).toEqual({
      kind: 'none',
    });
    expect(needsKey.banner).toEqual({ kind: 'needs-key' });
  });
});

describe('the dialog and its banner', () => {
  it('a device without the key opens a dialog; closing it leaves a banner that opens it again', () => {
    expect(dialogOpen(needsKey)).toBe(true);
    const closed = fold([{ type: 'dismissed' }], needsKey);
    expect(dialogOpen(closed)).toBe(false);
    expect(dialogOpen(fold([{ type: 'reopened' }], closed))).toBe(true);
  });

  it('a new moment opens as a dialog even after an earlier one was put aside', () => {
    const closed = fold([{ type: 'dismissed' }], needsKey);
    const asked = fold(
      [{ type: 'device-checked', pendingDevices: ASKING, acknowledged: true, shown: SHOWN }],
      closed
    );
    expect(dialogOpen(asked)).toBe(true);
  });

  it('the shown-once key cannot be put aside, only confirmed written down', () => {
    const shown = fold([{ type: 'enroll-answered', answer: { ok: true, shown: SHOWN } }]);
    expect(fold([{ type: 'dismissed' }], shown).dismissed).toBeNull();
    expect(fold([{ type: 'written-down' }], shown).banner).toEqual({ kind: 'none' });
  });
});

describe('typing the key', () => {
  it('Use this key is off until something is typed, and while it is being checked', () => {
    expect(canSubmitTypedKey(needsKey)).toBe(false);
    expect(canSubmitTypedKey(fold([{ type: 'typed-changed', value: '   ' }], needsKey))).toBe(
      false
    );
    const typed = fold([{ type: 'typed-changed', value: SHOWN }], needsKey);
    expect(canSubmitTypedKey(typed)).toBe(true);
    expect(canSubmitTypedKey(fold([{ type: 'typed-key-sent' }], typed))).toBe(false);
  });

  it('a key that does not parse says why and sends nothing', () => {
    const state = fold(
      [
        { type: 'typed-changed', value: 'abcd' },
        { type: 'typed-key-refused', error: 'A key is 14 groups of 4 characters.' },
      ],
      needsKey
    );
    expect(state.failure).toBe('A key is 14 groups of 4 characters.');
    expect(state.busy).toBe(false);
    expect(state.typed).toBe('abcd');
  });

  it('a key that is not this account’s keeps the dialog and what was typed, and says why', () => {
    const state = fold(
      [
        { type: 'typed-changed', value: SHOWN },
        { type: 'typed-key-sent' },
        { type: 'typed-key-answered', answer: { ok: false, failure: WRONG_KEY } },
      ],
      needsKey
    );
    expect(state.banner).toEqual({ kind: 'needs-key' });
    expect(state.failure).toBe(WRONG_KEY.error);
    expect(state.typed).toBe(SHOWN);
    expect(state.busy).toBe(false);
  });

  it('a new try clears the last refusal; the right key closes the dialog and empties the field', () => {
    const refused = fold(
      [
        { type: 'typed-changed', value: SHOWN },
        { type: 'typed-key-sent' },
        { type: 'typed-key-answered', answer: { ok: false, failure: WRONG_KEY } },
      ],
      needsKey
    );
    const retry = fold([{ type: 'typed-key-sent' }], refused);
    expect(retry.failure).toBeNull();
    const taken = fold([{ type: 'typed-key-answered', answer: { ok: true } }], retry);
    expect(taken.banner).toEqual({ kind: 'none' });
    expect(taken.typed).toBe('');
  });

  it('a typed key for a key service this browser has not met turns to the fingerprint', () => {
    const state = fold(
      [
        { type: 'typed-key-sent' },
        { type: 'typed-key-answered', answer: { ok: false, failure: UNTRUSTED } },
      ],
      needsKey
    );
    expect(state.banner).toEqual({ kind: 'trust', unknown: UNKNOWN });
    expect(state.failure).toBeNull();
  });
});

describe('asking another device', () => {
  it('shows the code to approve on the other device', () => {
    const state = fold([{ type: 'ask-requested' }, { type: 'ask-opened', ask: ASK }], needsKey);
    expect(state.ask?.code).toBe('QWERT-YUIOP');
  });

  it('an ask that could not start says why', () => {
    const state = fold(
      [{ type: 'ask-requested' }, { type: 'ask-refused', error: 'Too many requests.' }],
      needsKey
    );
    expect(state.ask).toBeNull();
    expect(state.failure).toBe('Too many requests.');
  });

  it('an expired or declined ask goes, with a line saying which', () => {
    const asked = fold([{ type: 'ask-opened', ask: ASK }], needsKey);
    expect(fold([{ type: 'ask-expired' }], asked)).toMatchObject({
      ask: null,
      failure: 'The request expired; ask again.',
    });
    expect(fold([{ type: 'ask-declined' }], asked)).toMatchObject({
      ask: null,
      failure: 'The request was declined.',
    });
  });

  it('a key sent from the other device closes the dialog; one that does not open says why', () => {
    const asked = fold([{ type: 'ask-opened', ask: ASK }], needsKey);
    expect(fold([{ type: 'ask-adopted', answer: { ok: true } }], asked)).toMatchObject({
      ask: null,
      banner: { kind: 'none' },
    });
    expect(
      fold([{ type: 'ask-adopted', answer: { ok: false, failure: WRONG_KEY } }], asked)
    ).toMatchObject({ ask: null, banner: { kind: 'needs-key' }, failure: WRONG_KEY.error });
  });
});

describe('the earlier passphrase', () => {
  const asked = fold([{ type: 'passphrase-needed' }]);

  it('Move my data is off until a passphrase is typed', () => {
    expect(canSubmitPassphrase(asked)).toBe(false);
    expect(canSubmitPassphrase(fold([{ type: 'passphrase-changed', value: ' ' }], asked))).toBe(
      true
    );
  });

  it('a refused passphrase stays on the dialog with the reason', () => {
    const state = fold(
      [
        { type: 'passphrase-changed', value: 'hunter2' },
        { type: 'passphrase-sent' },
        {
          type: 'passphrase-answered',
          answer: { ok: false, failure: { code: 'bad_passphrase', error: 'Wrong passphrase.' } },
        },
      ],
      asked
    );
    expect(state).toMatchObject({
      banner: { kind: 'passphrase' },
      failure: 'Wrong passphrase.',
      passphrase: 'hunter2',
      busy: false,
    });
  });

  it('the right one moves the data and shows the new key once', () => {
    const state = fold(
      [
        { type: 'passphrase-changed', value: 'hunter2' },
        { type: 'passphrase-sent' },
        { type: 'passphrase-answered', answer: { ok: true, shown: SHOWN } },
      ],
      asked
    );
    expect(state).toMatchObject({ banner: { kind: 'write-down', shown: SHOWN }, passphrase: '' });
  });
});

describe('another device asking for the key', () => {
  const asking = fold([
    { type: 'device-checked', pendingDevices: ASKING, acknowledged: true, shown: SHOWN },
  ]);

  it('Approve is off until the other device’s code is typed; the approval sends that code', () => {
    expect(canApprove(asking, 'req-1')).toBe(false);
    expect(codeFor(asking, 'req-1')).toBe('');
    const typed = fold(
      [{ type: 'code-changed', requestId: 'req-1', value: 'qwert-yuiop' }],
      asking
    );
    expect(canApprove(typed, 'req-1')).toBe(true);
    expect(codeFor(typed, 'req-1')).toBe('qwert-yuiop');
    expect(canApprove(fold([{ type: 'decision-sent' }], typed), 'req-1')).toBe(false);
  });

  it('a wrong code leaves the request for another try; a request closed by wrong codes is re-read', () => {
    const wrong = { code: 'wrong_code', error: 'That code does not match.' };
    expect(approvalRechecks(wrong)).toBe(false);
    expect(
      approvalRechecks({ code: 'wrong_code', error: 'Too many wrong codes; request closed.' })
    ).toBe(true);
    expect(approvalRechecks({ code: 'gone', error: 'That request is gone.' })).toBe(true);
    const state = fold(
      [{ type: 'decision-sent' }, { type: 'approval-refused', failure: wrong }],
      asking
    );
    expect(state).toMatchObject({ busy: false, failure: wrong.error, banner: { kind: 'approve' } });
  });

  it('a decision that went through frees the buttons for the re-check', () => {
    expect(fold([{ type: 'decision-sent' }, { type: 'decision-done' }], asking).busy).toBe(false);
  });
});

describe('a key service this browser has not met', () => {
  const trust = fold([{ type: 'enroll-answered', answer: { ok: false, failure: UNTRUSTED } }]);

  it('only an untrusted-instances refusal with fingerprints turns to the trust dialog', () => {
    expect(trustBannerFor(UNTRUSTED)).toEqual({ kind: 'trust', unknown: UNKNOWN });
    expect(trustBannerFor({ code: 'untrusted_instances', error: 'x' })).toBeNull();
    expect(trustBannerFor(WRONG_KEY)).toBeNull();
  });

  it('Not now leaves a banner to review it again; nothing is sealed meanwhile', () => {
    const later = fold([{ type: 'dismissed' }], trust);
    expect(later.banner.kind).toBe('trust');
    expect(dialogOpen(later)).toBe(false);
    expect(dialogOpen(fold([{ type: 'reopened' }], later))).toBe(true);
  });

  it('confirming it closes the dialog for the check that seals', () => {
    const sent = fold([{ type: 'dismissed' }, { type: 'reopened' }, { type: 'trust-sent' }], trust);
    expect(sent.busy).toBe(true);
    const done = fold([{ type: 'trust-confirmed' }], sent);
    expect(done).toMatchObject({ busy: false, banner: { kind: 'none' }, dismissed: null });
  });
});
