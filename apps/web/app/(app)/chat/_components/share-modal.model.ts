/**
 * The sharing dialog (share-modal.tsx) for chats, projects, prompt
 * libraries and artifacts: who has access as last loaded, the person
 * being added (found by name or email in the directory), the role and
 * the expiry, and what is in flight.
 *
 * The dialog makes the calls and dispatches what the person did and what
 * the server answered; what it decides from that — who is suggested,
 * which role a share carries, what Share sends, what a share or a
 * removal leaves on screen — is here, and tested in
 * share-modal.model.test.ts. The person search is shared with the
 * hand-over picker in artifact-dialogs.tsx.
 */

import type { GrantRole, GrantView, ResourceKind } from '@/lib/chat/access';

export interface Person {
  subject: string;
  email: string;
  displayName: string | null;
}

/** At most this many people are suggested at once. */
export const SUGGESTIONS = 6;

/**
 * The people a search suggests: an email or a name containing what was
 * typed, any case, less the ones excluded; nothing until something is typed.
 */
export function personSuggestions(
  people: readonly Person[],
  query: string,
  exclude: readonly string[] = []
): Person[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return people
    .filter((person) => !exclude.includes(person.subject))
    .filter(
      (person) =>
        person.email.toLowerCase().includes(needle) ||
        (person.displayName ?? '').toLowerCase().includes(needle)
    )
    .slice(0, SUGGESTIONS);
}

/** How a person is named: their display name, else their email. */
export const personName = (person: Person): string => person.displayName ?? person.email;

export interface ShareState {
  /** null until the first load answers. */
  grants: GrantView[] | null;
  people: Person[];
  query: string;
  chosen: Person | null;
  role: GrantRole;
  /** As the datetime-local field holds it; empty for no expiry. */
  expiresAt: string;
  busy: boolean;
  error: string | null;
}

export type ShareAction =
  | { type: 'grantsLoaded'; grants: GrantView[] }
  | { type: 'loadFailed'; error: string }
  | { type: 'peopleLoaded'; people: Person[] }
  | { type: 'typed'; query: string }
  | { type: 'chosen'; person: Person }
  | { type: 'unchosen' }
  | { type: 'roleChanged'; role: GrantRole }
  | { type: 'expiryChanged'; expiresAt: string }
  /** A share or a removal went out. */
  | { type: 'sent'; clearsError: boolean }
  | { type: 'shared' }
  | { type: 'revoked'; error: string | null }
  | { type: 'failed'; error: string };

export const initialShare: ShareState = {
  grants: null,
  people: [],
  query: '',
  chosen: null,
  role: 'viewer',
  expiresAt: '',
  busy: false,
  error: null,
};

export function shareReducer(state: ShareState, action: ShareAction): ShareState {
  switch (action.type) {
    case 'grantsLoaded':
      return { ...state, grants: action.grants };
    case 'loadFailed':
      return { ...state, error: action.error };
    case 'peopleLoaded':
      return { ...state, people: action.people };
    case 'typed':
      return { ...state, query: action.query };
    case 'chosen':
      return { ...state, chosen: action.person, query: '' };
    case 'unchosen':
      return { ...state, chosen: null };
    case 'roleChanged':
      return { ...state, role: action.role };
    case 'expiryChanged':
      return { ...state, expiresAt: action.expiresAt };
    case 'sent':
      return { ...state, busy: true, error: action.clearsError ? null : state.error };
    case 'shared':
      // Ready for the next person.
      return { ...state, busy: false, chosen: null, query: '', expiresAt: '' };
    case 'revoked':
      return { ...state, busy: false, error: action.error ?? state.error };
    case 'failed':
      return { ...state, busy: false, error: action.error };
  }
}

/** Chats and artifacts are shared to read or use, never to edit: no role to choose. */
export function hasRoles(kind: ResourceKind): boolean {
  return kind !== 'chat' && kind !== 'artifact';
}

/** Share is on once a person is chosen, while nothing is in flight. */
export function canShare(state: ShareState): boolean {
  return state.chosen !== null && !state.busy;
}

/** What Share sends, or null with nobody chosen. The expiry is read in the viewer's own time zone. */
export function grantRequest(
  kind: ResourceKind,
  state: ShareState
): { granteeSubject: string; role: GrantRole; expiresAt: string | null } | null {
  if (!state.chosen) return null;
  return {
    granteeSubject: state.chosen.subject,
    role: hasRoles(kind) ? state.role : 'viewer',
    expiresAt: state.expiresAt ? new Date(state.expiresAt).toISOString() : null,
  };
}

/** What a share lets its person do, as the list says it. */
export function grantAbility(kind: ResourceKind, grant: Pick<GrantView, 'role'>): string {
  return grant.role === 'editor' ? 'edit' : kind === 'artifact' ? 'use' : 'view';
}

/** Who a share is with, as the list names them. */
export function granteeName(grant: GrantView): string {
  return grant.granteeName ?? grant.granteeEmail ?? grant.granteeSubject;
}

/** The line at the top of the dialog: what sharing this kind of thing means. */
export function shareIntro(kind: ResourceKind): string {
  return kind === 'chat'
    ? 'People you share with can read this chat and watch it live. Only you can continue it.'
    : kind === 'artifact'
      ? 'Artifacts aren’t secret: anyone in a project or chat this file is used in can already read it. Sharing lets a person use it in projects of their own — attach it, read it, copy it — never change it.'
      : 'Only the people you add here can open this; its content is keyed to them.';
}
