/**
 * The Encryption key section's state (encryption-key-section.tsx): the
 * key status as last read, whether this device holds the key, the armed
 * "Replace my key", the new key shown once, the codes typed for asking
 * devices, and the line each choice leaves.
 *
 * The component runs the WebCrypto and IndexedDB flows
 * (lib/keys/browser/flows.ts) and dispatches what each answered;
 * everything decided from that — what is enabled, what a refusal says,
 * what a choice leaves on screen, what code an approval sends — is here,
 * and tested in encryption-key-section.model.test.ts.
 */

import type { KeyStatusView } from '@/lib/keys/shared';
import type { FlowFailure } from '@/lib/keys/browser/flows';

export interface KeySectionState {
  status: KeyStatusView;
  /** null until this device's store has been read: "Checking…". */
  deviceHasKey: boolean | null;
  busy: boolean;
  notice: string | null;
  failure: string | null;
  /** A new key from a rotation, shown until the person confirms it written down. */
  revealed: string | null;
  confirmRotate: boolean;
  typedCodes: Record<string, string>;
}

export function initKeySection(initial: KeyStatusView): KeySectionState {
  return {
    status: initial,
    deviceHasKey: null,
    busy: false,
    notice: null,
    failure: null,
    revealed: null,
    confirmRotate: false,
    typedCodes: {},
  };
}

export type FlowAnswer = { ok: true } | { ok: false; failure: FlowFailure };

export type KeySectionAction =
  /** GET /api/keys (null when it failed: the last status stays) and this device's store, read again. */
  | { type: 'refreshed'; status: KeyStatusView | null; deviceHasKey: boolean }
  /** A choice that needs the key, on a device without it: nothing is sent. */
  | { type: 'no-key'; need: 'extend' | 'share' }
  /** A change went out: the window, a pause, a rotation or a decision. */
  | { type: 'sent' }
  | { type: 'window-answered'; answer: FlowAnswer; days: number; now: number }
  | { type: 'pause-answered'; answer: FlowAnswer }
  | { type: 'rotate-asked' }
  | { type: 'rotate-kept' }
  | {
      type: 'rotate-answered';
      answer: { ok: true; shown: string } | { ok: false; failure: FlowFailure };
    }
  | { type: 'forgotten' }
  | { type: 'revealed-confirmed' }
  | { type: 'code-changed'; requestId: string; value: string }
  | { type: 'decision-answered'; answer: FlowAnswer };

const DAY_MS = 24 * 60 * 60_000;

/** A moment as the section writes it; empty for none. */
export function whenText(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** What a refused re-seal or rotation says: an unconfirmed key service is the dialog's to confirm. */
export function sealFailureText(failure: FlowFailure): string {
  return failure.code === 'untrusted_instances'
    ? 'This browser has not confirmed the key service yet; reload the page and confirm its fingerprint in the dialog first.'
    : failure.error;
}

export function keySectionReducer(
  state: KeySectionState,
  action: KeySectionAction
): KeySectionState {
  switch (action.type) {
    case 'refreshed':
      return {
        ...state,
        status: action.status ?? state.status,
        deviceHasKey: action.deviceHasKey,
      };
    case 'no-key':
      return {
        ...state,
        busy: false,
        failure:
          action.need === 'extend'
            ? 'This device does not hold your key, so it cannot extend your agents.'
            : 'This device does not hold your key, so it cannot share it.',
      };
    case 'sent':
      return { ...state, busy: true, failure: null };
    case 'window-answered':
      if (!action.answer.ok)
        return { ...state, busy: false, failure: sealFailureText(action.answer.failure) };
      return {
        ...state,
        busy: false,
        notice: `Your agents can run until ${whenText(new Date(action.now + action.days * DAY_MS).toISOString())}. Signing in extends this.`,
      };
    case 'pause-answered':
      return action.answer.ok
        ? {
            ...state,
            busy: false,
            notice: 'Your agents are paused. They run again after your next sign-in.',
          }
        : { ...state, busy: false, failure: action.answer.failure.error };
    case 'rotate-asked':
      return { ...state, confirmRotate: true };
    case 'rotate-kept':
      return { ...state, confirmRotate: false };
    case 'rotate-answered':
      return action.answer.ok
        ? {
            ...state,
            busy: false,
            confirmRotate: false,
            revealed: action.answer.shown,
            notice: 'Your key was replaced. Every other device needs the new one.',
          }
        : {
            ...state,
            busy: false,
            confirmRotate: false,
            failure: sealFailureText(action.answer.failure),
          };
    case 'forgotten':
      return {
        ...state,
        notice:
          'This device no longer holds your key. Next time, type it or approve from another device.',
      };
    case 'revealed-confirmed':
      return { ...state, revealed: null };
    case 'code-changed':
      return { ...state, typedCodes: { ...state.typedCodes, [action.requestId]: action.value } };
    case 'decision-answered':
      return action.answer.ok
        ? { ...state, busy: false }
        : { ...state, busy: false, failure: action.answer.failure.error };
  }
}

/** The agents may run unattended: a live instance holds the automation delegation, until a time. */
export function automationOn(status: KeyStatusView): boolean {
  return status.automationInstances.length > 0 && status.automationUntil !== null;
}

/** The line under "Your agents". */
export function automationText(status: KeyStatusView): string {
  return automationOn(status)
    ? `Your agents can run until ${whenText(status.automationUntil)}. Signing in extends this.`
    : 'Your agents are paused until your next sign-in.';
}

/** The window can change unless something is in flight or this device is known not to hold the key. */
export function canChangeWindow(state: KeySectionState): boolean {
  return !state.busy && state.deviceHasKey !== false;
}

/** A rotation needs the key on this device, known to be there. */
export function canRotate(state: KeySectionState): boolean {
  return !state.busy && state.deviceHasKey === true;
}

export function codeFor(state: KeySectionState, requestId: string): string {
  return state.typedCodes[requestId] ?? '';
}

export function canApprove(state: KeySectionState, requestId: string): boolean {
  return canRotate(state) && codeFor(state, requestId).trim().length > 0;
}
