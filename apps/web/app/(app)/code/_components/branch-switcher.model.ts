/**
 * The Switch branch dialog (branch-switcher.tsx): the branches as listed,
 * the one the checkout is on as far as this dialog knows, a switch in
 * flight, and a refusal — with, for a dirty tree, the branch the person
 * asked for, so "Discard changes and switch" can retry it.
 *
 * The component makes the GET, the switch POST and the discard POST and
 * dispatches what they answered; what each answer leaves on screen and
 * what may be pressed is here, tested in branch-switcher.model.test.ts.
 */

import { isRecord, isString } from '@renkei/guards';

export interface HostBranch {
  name: string;
  headSha: string;
}

export interface BranchState {
  /** null until the list answers. */
  branches: HostBranch[] | null;
  loadError: string | null;
  switching: boolean;
  discarding: boolean;
  /** Why the last switch or discard was refused; the notice shows while there is one. */
  error: string | null;
  /** The refusal's code ('dirty', 'busy', …), when the route gave one. */
  errorCode: string | null;
  /** The branch a dirty tree refused, for Discard to retry. */
  pendingBranch: string | null;
  /** The branch the checkout is on, as shown: moved at once on a switch. */
  shown: string | null;
}

export type BranchAction =
  | { type: 'loaded'; branches: HostBranch[] }
  | { type: 'loadFailed'; error: string }
  | { type: 'switchStarted' }
  | { type: 'switchRefused'; branch: string; error: string; code: string | null }
  | { type: 'switched'; branch: string }
  | { type: 'discardStarted' }
  | { type: 'discardRefused'; error: string; code: string | null }
  | { type: 'discarded' }
  /** The project's own idea of the branch moved (a refresh). */
  | { type: 'branchChanged'; branch: string | null };

export function initialBranch(branch: string | null): BranchState {
  return {
    branches: null,
    loadError: null,
    switching: false,
    discarding: false,
    error: null,
    errorCode: null,
    pendingBranch: null,
    shown: branch,
  };
}

export function branchReducer(state: BranchState, action: BranchAction): BranchState {
  switch (action.type) {
    case 'loaded':
      return { ...state, branches: action.branches };
    case 'loadFailed':
      return { ...state, loadError: action.error };
    case 'switchStarted':
      return { ...state, switching: true, error: null, errorCode: null };
    case 'switchRefused':
      return {
        ...state,
        switching: false,
        error: action.error,
        errorCode: action.code,
        pendingBranch: action.code === 'dirty' ? action.branch : null,
      };
    case 'switched':
      // The list is read again next time the dialog opens.
      return {
        ...state,
        switching: false,
        shown: action.branch,
        branches: null,
        pendingBranch: null,
      };
    case 'discardStarted':
      return { ...state, discarding: true };
    case 'discardRefused':
      // The tree is still dirty as far as anyone knows: the offer stays.
      return { ...state, discarding: false, error: action.error };
    case 'discarded':
      return { ...state, discarding: false };
    case 'branchChanged':
      return { ...state, shown: action.branch };
  }
}

/** The refusal's `code`, from an error body. */
export function errorCodeOf(data: unknown): string | null {
  return isRecord(data) && isString(data.code) ? data.code : null;
}

/** A branch press switches only to another branch, and not while a switch is going. */
export function canPick(state: BranchState, name: string): boolean {
  return name !== state.shown && !state.switching;
}

/** The notice under the list: the refusal, and for a dirty tree the way through. */
export function blockedNotice(state: BranchState): {
  message: string | null;
  /** The discard button's words; null when a discard is no way through. */
  discard: string | null;
} | null {
  // Every refusal is shown, with a code or without (a 500, an unreachable
  // server); only a dirty tree offers the discard.
  if (!state.error) return null;
  const offer = state.pendingBranch;
  return {
    message: state.error,
    discard: offer
      ? state.discarding
        ? 'Discarding…'
        : `Discard changes and switch to ${state.pendingBranch}`
      : null,
  };
}
