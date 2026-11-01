/**
 * One file share's edit page (share-config-form.tsx), with no network or
 * React: the draft as the stored share fills it, the SSH host-key status
 * (from what is STORED, so an admin can confirm a key recorded on first
 * use), what Save and Delete leave on screen, and the rule that a load
 * landing after the person started typing does not put the stored values
 * back. The draft itself is ../share-config-fields.model.ts. Tested in
 * share-config-form.model.test.ts.
 */

import { editDraft, emptyDraft, type ShareDraft } from '../share-config-fields.model';

/** What GET /api/admin/file-shares/<id> answers under `share`. */
export interface StoredShare {
  id: string;
  name: string;
  protocol: 'smb' | 'sftp';
  host: string;
  port: number | null;
  shareName: string | null;
  rootPath: string;
  caseInsensitive: boolean;
  enabled: boolean;
  hostKeyFingerprint: string | null;
}

export interface ShareFormState {
  /** null until the first load answers. */
  draft: ShareDraft | null;
  /** The person changed the draft since it was last loaded or saved. */
  edited: boolean;
  busy: boolean;
  status: { kind: 'ok' | 'error'; text: string } | null;
  /** The host key the server has on file. */
  recordedHostKey: string | null;
}

export const initialShareForm: ShareFormState = {
  draft: null,
  edited: false,
  busy: false,
  status: null,
  recordedHostKey: null,
};

export type ShareFormAction =
  | { type: 'loaded'; share: StoredShare }
  | { type: 'load-failed'; error: string }
  | { type: 'edit'; patch: Partial<ShareDraft> }
  /** Save or Delete went out. */
  | { type: 'sent' }
  | { type: 'saved' }
  | { type: 'failed'; error: string };

/** The draft a stored share opens as: a port only when one is set. */
export function draftFromShare(share: StoredShare): ShareDraft {
  return {
    ...emptyDraft(),
    name: share.name,
    protocol: share.protocol,
    host: share.host,
    port: share.port === null ? '' : String(share.port),
    shareName: share.shareName ?? '',
    rootPath: share.rootPath,
    caseInsensitive: share.caseInsensitive,
    enabled: share.enabled,
    hostKeyFingerprint: share.hostKeyFingerprint ?? '',
  };
}

export function shareFormReducer(state: ShareFormState, action: ShareFormAction): ShareFormState {
  switch (action.type) {
    case 'loaded': {
      const recordedHostKey = action.share.hostKeyFingerprint;
      // A load that lands after the person started typing keeps what they
      // typed; the key on file still follows what is stored.
      if (state.draft && state.edited) return { ...state, recordedHostKey };
      return { ...state, draft: draftFromShare(action.share), edited: false, recordedHostKey };
    }
    case 'load-failed':
      return { ...state, status: { kind: 'error', text: action.error } };
    case 'edit':
      return state.draft
        ? { ...state, draft: editDraft(state.draft, action.patch), edited: true }
        : state;
    case 'sent':
      return { ...state, busy: true, status: null };
    case 'saved':
      return { ...state, busy: false, edited: false, status: { kind: 'ok', text: 'Saved.' } };
    case 'failed':
      return { ...state, busy: false, status: { kind: 'error', text: action.error } };
  }
}

/**
 * The host-key status above an SFTP share's fields: the key on file, or
 * that the first connection will record one. An SMB share shows none.
 */
export function hostKeyStatus(
  state: ShareFormState
): null | { kind: 'on-file'; fingerprint: string } | { kind: 'first-use' } {
  if (state.draft?.protocol !== 'sftp') return null;
  return state.recordedHostKey
    ? { kind: 'on-file', fingerprint: state.recordedHostKey }
    : { kind: 'first-use' };
}

export const DELETE_CONFIRMATION =
  "Delete this share? Everyone's stored connections to it go with it.";
