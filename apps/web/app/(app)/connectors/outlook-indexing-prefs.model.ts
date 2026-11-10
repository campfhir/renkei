/**
 * The Outlook background opt-in on the Microsoft 365 card
 * (outlook-indexing-prefs.tsx): the one Mail toggle, which saves the moment
 * it is clicked. What the section decides — that it stays off until the
 * saved choice is read, what a click sends, that the toggle moves at once
 * and goes back if the save is refused, and what the line under it says —
 * is here, and tested in outlook-indexing-prefs.model.test.ts. The route's
 * side (what is stored, a calendar or tasks flag dropped) is route tests
 * beside app/api/microsoft/indexing.
 */

import { isRecord } from '@renkei/guards';

export const CATEGORIES = [
  {
    key: 'mail' as const,
    label: 'Mail',
    hint:
      'New mail can wake your agents through the "An email arrives" trigger. Messages are read ' +
      'live as you and are never indexed.',
  },
];

export type Prefs = { mail: boolean };
export type PrefKey = keyof Prefs;

export interface OutlookPrefsState {
  /** null until the saved choice is read: the toggle is off and disabled until then. */
  prefs: Prefs | null;
  busy: boolean;
  notice: string | null;
}

export type OutlookPrefsAction =
  | { type: 'loaded'; prefs: Prefs }
  /** A click: the toggle moves at once while the save goes out. */
  | { type: 'toggled'; key: PrefKey; on: boolean }
  | { type: 'saved'; on: boolean }
  /** A refused or unreachable save: the toggle goes back to `previous`. */
  | { type: 'failed'; previous: Prefs; notice: string };

export const initialOutlookPrefs: OutlookPrefsState = { prefs: null, busy: false, notice: null };

export function noticeFor(on: boolean): string {
  return on
    ? 'New mail will start waking agents with an "An email arrives" trigger within a few minutes. ' +
        'Nothing is indexed.'
    : 'New mail no longer wakes your agents.';
}

/** The saved choice from GET /api/microsoft/indexing, or null when the answer has none. */
export function prefsOf(body: unknown): Prefs | null {
  if (!isRecord(body) || !isRecord(body.indexing)) return null;
  return { mail: body.indexing.mail === true };
}

/** What a click sends: the whole choice with that one key changed. */
export function toggleRequest(prefs: Prefs, key: PrefKey, on: boolean): Prefs {
  return { ...prefs, [key]: on };
}

export function outlookPrefsReducer(
  state: OutlookPrefsState,
  action: OutlookPrefsAction
): OutlookPrefsState {
  switch (action.type) {
    case 'loaded':
      return { ...state, prefs: action.prefs };
    case 'toggled':
      if (!state.prefs) return state;
      return {
        prefs: toggleRequest(state.prefs, action.key, action.on),
        busy: true,
        notice: null,
      };
    case 'saved':
      return { ...state, busy: false, notice: noticeFor(action.on) };
    case 'failed':
      return { prefs: action.previous, busy: false, notice: action.notice };
  }
}

/** Whether a toggle can be clicked: the choice is read and no save is in flight. */
export function toggleEnabled(state: OutlookPrefsState): boolean {
  return state.prefs !== null && !state.busy;
}

export function isChecked(state: OutlookPrefsState, key: PrefKey): boolean {
  return state.prefs?.[key] ?? false;
}

/** The server's refusal words, or "Could not save." */
export function refusalNotice(body: unknown): string {
  return isRecord(body) && typeof body.error === 'string' ? body.error : 'Could not save.';
}
