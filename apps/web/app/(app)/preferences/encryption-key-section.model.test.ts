/**
 * The Encryption key section on Preferences
 * (encryption-key-section.model.ts): what each choice is allowed and what
 * it leaves on screen. keys.spec.ts drives the real pause, forget and
 * rotation through the browser (they run WebCrypto and IndexedDB); the
 * rules around them are here.
 */

import type { KeyStatusView } from '@/lib/keys/shared';
import type { FlowFailure } from '@/lib/keys/browser/flows';
import {
  automationOn,
  automationText,
  canApprove,
  canChangeWindow,
  canRotate,
  codeFor,
  initKeySection,
  keySectionReducer,
  sealFailureText,
  whenText,
  type KeySectionAction,
  type KeySectionState,
} from './encryption-key-section.model';

const NOW = Date.parse('2026-06-01T12:00:00.000Z');
const DAY = 24 * 60 * 60_000;
const SHOWN = 'abcd-efgh-ijkl-mnop-qrst-uvwx-yz23-4567-abcd-efgh-ijkl-mnop-qrst-uvwx';
const UNTRUSTED: FlowFailure = {
  code: 'untrusted_instances',
  error: 'Confirm the key service first.',
  unknown: [{ id: 'i-9', publicKey: 'k', fingerprint: 'ABCDE-FGHIJ' }],
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
    automationUntil: '2026-07-01T12:00:00.000Z',
    automationDays: 30,
    pendingDevices: [],
    unavailable: false,
    ...overrides,
  };
}

const fold = (actions: KeySectionAction[], from: KeySectionState = initKeySection(status())) =>
  actions.reduce(keySectionReducer, from);

const holding = fold([{ type: 'refreshed', status: status(), deviceHasKey: true }]);
const without = fold([{ type: 'refreshed', status: status(), deviceHasKey: false }]);

describe('the section as it opens', () => {
  it('says "Checking…" for this device until its store is read, and starts with nothing armed', () => {
    const opened = initKeySection(status());
    expect(opened).toMatchObject({
      deviceHasKey: null,
      busy: false,
      notice: null,
      failure: null,
      revealed: null,
      confirmRotate: false,
    });
  });

  it('a failed status read keeps the last one; the device answer always lands', () => {
    const next = fold([{ type: 'refreshed', status: null, deviceHasKey: false }], holding);
    expect(next.status).toBe(holding.status);
    expect(next.deviceHasKey).toBe(false);
  });
});

describe('your agents', () => {
  it('run until the window ends while a key service holds the automation key', () => {
    expect(automationOn(status())).toBe(true);
    expect(automationText(status())).toBe(
      `Your agents can run until ${whenText('2026-07-01T12:00:00.000Z')}. Signing in extends this.`
    );
  });

  it('are paused with no automation delegation or no end to the window', () => {
    for (const paused of [status({ automationInstances: [] }), status({ automationUntil: null })]) {
      expect(automationOn(paused)).toBe(false);
      expect(automationText(paused)).toBe('Your agents are paused until your next sign-in.');
    }
  });

  it('the window can change until this device is known not to hold the key', () => {
    expect(canChangeWindow(initKeySection(status()))).toBe(true);
    expect(canChangeWindow(holding)).toBe(true);
    expect(canChangeWindow(without)).toBe(false);
    expect(canChangeWindow(fold([{ type: 'sent' }], holding))).toBe(false);
  });

  it('a new window says until when, from the moment it was set', () => {
    const state = fold(
      [{ type: 'sent' }, { type: 'window-answered', answer: { ok: true }, days: 7, now: NOW }],
      holding
    );
    expect(state.busy).toBe(false);
    expect(state.notice).toBe(
      `Your agents can run until ${whenText(new Date(NOW + 7 * DAY).toISOString())}. Signing in extends this.`
    );
  });

  it('a window on a device without the key is refused before anything is sent', () => {
    const state = fold([{ type: 'no-key', need: 'extend' }], without);
    expect(state.failure).toBe(
      'This device does not hold your key, so it cannot extend your agents.'
    );
    expect(state.busy).toBe(false);
  });

  it('a key service this browser has not confirmed sends the person to the dialog', () => {
    expect(sealFailureText(UNTRUSTED)).toBe(
      'This browser has not confirmed the key service yet; reload the page and confirm its fingerprint in the dialog first.'
    );
    expect(sealFailureText({ code: 'http_500', error: 'The key service failed.' })).toBe(
      'The key service failed.'
    );
    const state = fold(
      [
        { type: 'sent' },
        { type: 'window-answered', answer: { ok: false, failure: UNTRUSTED }, days: 7, now: NOW },
      ],
      holding
    );
    expect(state.failure).toBe(sealFailureText(UNTRUSTED));
    expect(state.notice).toBeNull();
  });

  it('pausing says when they run again; a refused pause says why', () => {
    expect(
      fold([{ type: 'sent' }, { type: 'pause-answered', answer: { ok: true } }], holding).notice
    ).toBe('Your agents are paused. They run again after your next sign-in.');
    const refused = fold(
      [
        { type: 'sent' },
        { type: 'pause-answered', answer: { ok: false, failure: { code: 'x', error: 'Nope.' } } },
      ],
      holding
    );
    expect(refused).toMatchObject({ busy: false, failure: 'Nope.', notice: null });
  });

  it('a new attempt clears the last refusal', () => {
    const refused = fold([{ type: 'no-key', need: 'extend' }], holding);
    expect(fold([{ type: 'sent' }], refused).failure).toBeNull();
  });
});

describe('this device', () => {
  it('forgetting it says how to bring the key back', () => {
    expect(fold([{ type: 'forgotten' }], holding).notice).toBe(
      'This device no longer holds your key. Next time, type it or approve from another device.'
    );
  });
});

describe('a new key', () => {
  it('can be replaced only from a device known to hold the key, and not while busy', () => {
    expect(canRotate(initKeySection(status()))).toBe(false);
    expect(canRotate(without)).toBe(false);
    expect(canRotate(holding)).toBe(true);
    expect(canRotate(fold([{ type: 'sent' }], holding))).toBe(false);
  });

  it('asks once before replacing; Keep it takes the question back', () => {
    const asked = fold([{ type: 'rotate-asked' }], holding);
    expect(asked.confirmRotate).toBe(true);
    expect(fold([{ type: 'rotate-kept' }], asked).confirmRotate).toBe(false);
  });

  it('a replaced key is shown once, until it is confirmed written down', () => {
    const rotated = fold(
      [
        { type: 'rotate-asked' },
        { type: 'sent' },
        { type: 'rotate-answered', answer: { ok: true, shown: SHOWN } },
      ],
      holding
    );
    expect(rotated).toMatchObject({
      busy: false,
      confirmRotate: false,
      revealed: SHOWN,
      notice: 'Your key was replaced. Every other device needs the new one.',
    });
    expect(fold([{ type: 'revealed-confirmed' }], rotated).revealed).toBeNull();
  });

  it('a refused rotation keeps the old key, shows nothing, and says why', () => {
    const refused = fold(
      [
        { type: 'rotate-asked' },
        { type: 'sent' },
        { type: 'rotate-answered', answer: { ok: false, failure: UNTRUSTED } },
      ],
      holding
    );
    expect(refused).toMatchObject({
      confirmRotate: false,
      revealed: null,
      failure: sealFailureText(UNTRUSTED),
    });
  });
});

describe('devices asking for the key', () => {
  it('Approve needs the key on this device and the other device’s code; it sends that code', () => {
    expect(canApprove(holding, 'req-1')).toBe(false);
    const typed = fold(
      [{ type: 'code-changed', requestId: 'req-1', value: 'QWERT-YUIOP' }],
      holding
    );
    expect(canApprove(typed, 'req-1')).toBe(true);
    expect(codeFor(typed, 'req-1')).toBe('QWERT-YUIOP');
    expect(codeFor(typed, 'req-2')).toBe('');
    const typedWithout = fold(
      [{ type: 'code-changed', requestId: 'req-1', value: 'QWERT-YUIOP' }],
      without
    );
    expect(canApprove(typedWithout, 'req-1')).toBe(false);
  });

  it('an approval on a device that lost the key says it cannot share it', () => {
    const state = fold([{ type: 'sent' }, { type: 'no-key', need: 'share' }], holding);
    expect(state).toMatchObject({
      busy: false,
      failure: 'This device does not hold your key, so it cannot share it.',
    });
  });

  it('a wrong code says why; a decision that went through frees the buttons', () => {
    const wrong = fold(
      [
        { type: 'sent' },
        {
          type: 'decision-answered',
          answer: {
            ok: false,
            failure: { code: 'wrong_code', error: 'That code does not match.' },
          },
        },
      ],
      holding
    );
    expect(wrong).toMatchObject({ busy: false, failure: 'That code does not match.' });
    expect(
      fold([{ type: 'sent' }, { type: 'decision-answered', answer: { ok: true } }], holding)
    ).toMatchObject({ busy: false, failure: null });
  });
});
