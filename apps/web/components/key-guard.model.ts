/**
 * The key dialog's state (key-guard.tsx): which of the person's key
 * moments is on screen — the key shown once after enrollment, a device
 * without the key, the passphrase of a pre-enrollment key, another device
 * asking, a key service this browser has not met, the key service
 * unreachable — whether they put it aside for a banner, and what they
 * have typed.
 *
 * The component reads GET /api/keys, runs the WebCrypto and IndexedDB
 * flows (lib/keys/browser/flows.ts) and dispatches what each answered;
 * everything decided from that — which step a check takes, which dialog
 * shows, what a refusal leaves on screen, whether a decision re-checks,
 * what code an approval sends — is here, and tested in
 * key-guard.model.test.ts. Nothing here imports from components/.
 */

import type { KeyStatusView } from '@/lib/keys/shared';
import type { DeviceAsk, FlowFailure, UnknownInstance } from '@/lib/keys/browser/flows';

export type PendingDevice = KeyStatusView['pendingDevices'][number];

export type Banner =
  | { kind: 'none' }
  | { kind: 'write-down'; shown: string }
  | { kind: 'needs-key' }
  | { kind: 'passphrase' }
  | { kind: 'approve'; requests: PendingDevice[] }
  /** A delegate instance this browser has not sealed to before: confirm its fingerprint first. */
  | { kind: 'trust'; unknown: UnknownInstance[] }
  | { kind: 'unavailable' };

export interface KeyGuardState {
  banner: Banner;
  /**
   * The dialog the person put aside (the key is needed, but not for this
   * page): it shows as a banner with a way back until the moment changes.
   */
  dismissed: Banner['kind'] | null;
  busy: boolean;
  failure: string | null;
  typed: string;
  passphrase: string;
  /** This device's open ask of the person's other devices. */
  ask: DeviceAsk | null;
  /** What the person typed off each asking device's screen, by request id. */
  typedCodes: Record<string, string>;
}

export const initialKeyGuard: KeyGuardState = {
  banner: { kind: 'none' },
  dismissed: null,
  busy: false,
  failure: null,
  typed: '',
  passphrase: '',
  ask: null,
  typedCodes: {},
};

/** A flow's answer: nothing wrong, or what was refused. */
export type FlowAnswer = { ok: true } | { ok: false; failure: FlowFailure };
/** An enrollment's answer: the key to show once, or what was refused. */
export type EnrollAnswer = { ok: true; shown: string } | { ok: false; failure: FlowFailure };

export type KeyGuardAction =
  /** GET /api/keys failed, or the delegate is down. */
  | { type: 'status-unavailable' }
  /** A pre-enrollment key on a passphrase: the person must type it once. */
  | { type: 'passphrase-needed' }
  /** The silent enrollment a check started answered. */
  | { type: 'enroll-answered'; answer: EnrollAnswer }
  /** The re-seal a check started (this device holds the key) answered. */
  | { type: 'delegate-answered'; answer: FlowAnswer }
  /** This device holds the key and nothing needed sealing: what is left to show. */
  | {
      type: 'device-checked';
      pendingDevices: PendingDevice[];
      acknowledged: boolean;
      /** The device's key in its written-down form, for a key never confirmed written down. */
      shown: string;
    }
  /** Enrolled, and this device has no key. */
  | { type: 'device-without-key'; sessionDelegated: boolean }
  | { type: 'dismissed' }
  | { type: 'reopened' }
  | { type: 'typed-changed'; value: string }
  | { type: 'passphrase-changed'; value: string }
  | { type: 'code-changed'; requestId: string; value: string }
  /** The typed key does not even parse; nothing is sent. */
  | { type: 'typed-key-refused'; error: string }
  | { type: 'typed-key-sent' }
  | { type: 'typed-key-answered'; answer: FlowAnswer }
  | { type: 'ask-requested' }
  | { type: 'ask-refused'; error: string }
  | { type: 'ask-opened'; ask: DeviceAsk }
  | { type: 'ask-expired' }
  | { type: 'ask-declined' }
  /** Another device sealed the key to this ask, and adopting it answered. */
  | { type: 'ask-adopted'; answer: FlowAnswer }
  | { type: 'passphrase-sent' }
  | { type: 'passphrase-answered'; answer: EnrollAnswer }
  | { type: 'decision-sent' }
  /** An approval was refused; whether the dialog re-checks is `approvalRechecks`'s. */
  | { type: 'approval-refused'; failure: FlowFailure }
  | { type: 'decision-done' }
  | { type: 'written-down' }
  | { type: 'trust-sent' }
  | { type: 'trust-confirmed' };

/** The trust dialog for an `untrusted_instances` refusal; null for any other. */
export function trustBannerFor(failure: FlowFailure): Banner | null {
  if (failure.code !== 'untrusted_instances' || !failure.unknown) return null;
  return { kind: 'trust', unknown: failure.unknown };
}

/** The key service answered and is up: a check can go on. */
export function statusUsable(status: KeyStatusView | null): status is KeyStatusView {
  return status !== null && !status.unavailable;
}

const DAY_MS = 24 * 60 * 60_000;

/** Signing in extends the automation window: renew once half of it has passed. */
export function renewDue(status: KeyStatusView, now: number): boolean {
  if (!status.automationUntil) return false;
  return new Date(status.automationUntil).getTime() - now < (status.automationDays * DAY_MS) / 2;
}

/** What a check does with a usable status and whether this device holds the key. */
export type CheckStep =
  | { kind: 'passphrase' }
  | { kind: 'enroll' }
  /** This device holds the key: seal this session's delegation, or renew the window, then look further. */
  | { kind: 'device'; delegate: boolean; renew: boolean }
  | { kind: 'no-device-key' };

export function checkStep(status: KeyStatusView, hasDeviceKey: boolean, now: number): CheckStep {
  if (!status.enrolled) {
    return status.legacy && status.legacyNeedsPassphrase
      ? { kind: 'passphrase' }
      : { kind: 'enroll' };
  }
  if (!hasDeviceKey) return { kind: 'no-device-key' };
  const delegate = !status.sessionDelegated;
  return { kind: 'device', delegate, renew: !delegate && renewDue(status, now) };
}

/**
 * Whether a check stops at the re-seal's answer: a key service to confirm
 * first, or a device key that is not this account's any more (a rotation
 * elsewhere). Any other refusal leaves the check to look further.
 */
export function delegationStops(answer: FlowAnswer): boolean {
  if (answer.ok) return false;
  return trustBannerFor(answer.failure) !== null || answer.failure.code === 'wrong_key';
}

/**
 * After a refused approval, whether the dialog checks again: a wrong code
 * leaves the request listed for another try, unless too many wrong codes
 * closed it; anything else re-reads the list.
 */
export function approvalRechecks(failure: FlowFailure): boolean {
  return !(failure.code === 'wrong_code' && !/closed/.test(failure.error));
}

export function keyGuardReducer(state: KeyGuardState, action: KeyGuardAction): KeyGuardState {
  switch (action.type) {
    case 'status-unavailable':
      // The shown-once key stays until it is confirmed written down.
      return state.banner.kind === 'write-down'
        ? state
        : { ...state, banner: { kind: 'unavailable' } };
    case 'passphrase-needed':
      return { ...state, banner: { kind: 'passphrase' } };
    case 'enroll-answered': {
      if (action.answer.ok)
        return { ...state, banner: { kind: 'write-down', shown: action.answer.shown } };
      const trust = trustBannerFor(action.answer.failure);
      if (trust) return { ...state, banner: trust };
      return { ...state, failure: action.answer.failure.error, banner: { kind: 'unavailable' } };
    }
    case 'delegate-answered': {
      if (action.answer.ok) return state;
      const trust = trustBannerFor(action.answer.failure);
      if (trust) return { ...state, banner: trust };
      if (action.answer.failure.code === 'wrong_key')
        return { ...state, banner: { kind: 'needs-key' } };
      return state;
    }
    case 'device-checked':
      if (action.pendingDevices.length > 0)
        return { ...state, banner: { kind: 'approve', requests: action.pendingDevices } };
      if (!action.acknowledged)
        return { ...state, banner: { kind: 'write-down', shown: action.shown } };
      return { ...state, banner: { kind: 'none' } };
    case 'device-without-key':
      // Fine while this session is delegated (another browser did it).
      return {
        ...state,
        banner: action.sessionDelegated ? { kind: 'none' } : { kind: 'needs-key' },
      };
    case 'dismissed':
      // The shown-once key cannot be put aside, only confirmed written down.
      return state.banner.kind === 'write-down'
        ? state
        : { ...state, dismissed: state.banner.kind };
    case 'reopened':
      return { ...state, dismissed: null };
    case 'typed-changed':
      return { ...state, typed: action.value };
    case 'passphrase-changed':
      return { ...state, passphrase: action.value };
    case 'code-changed':
      return { ...state, typedCodes: { ...state.typedCodes, [action.requestId]: action.value } };
    case 'typed-key-refused':
      return { ...state, failure: action.error };
    case 'typed-key-sent':
    case 'passphrase-sent':
    case 'decision-sent':
      return { ...state, busy: true, failure: null };
    case 'typed-key-answered': {
      const answered = { ...state, busy: false };
      if (action.answer.ok) return { ...answered, typed: '', banner: { kind: 'none' } };
      const trust = trustBannerFor(action.answer.failure);
      if (trust) return { ...answered, banner: trust };
      return { ...answered, failure: action.answer.failure.error };
    }
    case 'ask-requested':
      return { ...state, failure: null };
    case 'ask-refused':
      return { ...state, failure: action.error };
    case 'ask-opened':
      return { ...state, ask: action.ask };
    case 'ask-expired':
      return { ...state, ask: null, failure: 'The request expired; ask again.' };
    case 'ask-declined':
      return { ...state, ask: null, failure: 'The request was declined.' };
    case 'ask-adopted':
      return action.answer.ok
        ? { ...state, ask: null, banner: { kind: 'none' } }
        : { ...state, ask: null, failure: action.answer.failure.error };
    case 'passphrase-answered':
      return action.answer.ok
        ? {
            ...state,
            busy: false,
            passphrase: '',
            banner: { kind: 'write-down', shown: action.answer.shown },
          }
        : { ...state, busy: false, failure: action.answer.failure.error };
    case 'approval-refused':
      return { ...state, busy: false, failure: action.failure.error };
    case 'decision-done':
      return { ...state, busy: false };
    case 'written-down':
      return { ...state, banner: { kind: 'none' } };
    case 'trust-sent':
      return { ...state, busy: true };
    case 'trust-confirmed':
      return { ...state, busy: false, banner: { kind: 'none' }, dismissed: null };
  }
}

/** The moment shows as its dialog (rather than its banner) unless the person put it aside. */
export function dialogOpen(state: KeyGuardState): boolean {
  return state.dismissed !== state.banner.kind;
}

export function canSubmitTypedKey(state: KeyGuardState): boolean {
  return !state.busy && state.typed.trim().length > 0;
}

export function canSubmitPassphrase(state: KeyGuardState): boolean {
  return !state.busy && state.passphrase.length > 0;
}

/** The code an approval of this request sends: what the person typed off the asking device. */
export function codeFor(state: KeyGuardState, requestId: string): string {
  return state.typedCodes[requestId] ?? '';
}

export function canApprove(state: KeyGuardState, requestId: string): boolean {
  return !state.busy && codeFor(state, requestId).trim().length > 0;
}
