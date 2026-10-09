/**
 * The delegate's error vocabulary: the generic worker tags plus every
 * verdict @renkei/user-keys can hand back, so a caller hears the same
 * word the key store said and can act on it. The three that matter to a
 * page: NEEDS_DELEGATION (the browser must seal the person's key to this
 * instance again), NEEDS_SESSION (only the automation key is delegated
 * and the operation needs the person present) and NOT_ENROLLED (their
 * next sign-in enrolls them).
 */

import type { ServerResponse } from 'node:http';
import type { GenericWorkerError } from '@renkei/worker-kit';
import { sendJson } from '@renkei/worker-kit';

export type DelegateErrorType =
  | GenericWorkerError
  // @renkei/user-keys: KeyError
  | 'NO_USER_KEY'
  | 'NOT_ENROLLED'
  | 'NEEDS_DELEGATION'
  | 'NEEDS_SESSION'
  | 'NO_VAULT'
  | 'DECRYPTION_ERROR'
  // OpenKeyError, ShareKeyError
  | 'NO_KEY'
  | 'NO_ACCESS'
  | 'GRANTEE_NOT_ENROLLED'
  // enrollment, delegation, rotation
  | 'BAD_DELEGATION'
  | 'KEY_MISMATCH'
  | 'ALREADY_ENROLLED'
  | 'MIGRATION_UNAVAILABLE'
  | 'KEY_LOCKED'
  | 'WRONG_PASSPHRASE'
  // the caller's binding (server.ts): the session or run named is not this person's
  | 'SESSION_MISMATCH'
  | 'RUN_MISMATCH';

export function statusForError(type: DelegateErrorType): number {
  switch (type) {
    case 'bad_request':
    case 'BAD_DELEGATION':
    case 'KEY_MISMATCH':
      return 400;
    case 'unauthorized':
      return 401;
    case 'forbidden':
    case 'NO_ACCESS':
    case 'WRONG_PASSPHRASE':
    case 'SESSION_MISMATCH':
    case 'RUN_MISMATCH':
      return 403;
    case 'unknown_operation':
    case 'NO_KEY':
    case 'NO_USER_KEY':
      return 404;
    case 'method_not_allowed':
      return 405;
    case 'ALREADY_ENROLLED':
    case 'GRANTEE_NOT_ENROLLED':
      return 409;
    case 'too_large':
      return 413;
    case 'NEEDS_DELEGATION':
    case 'NEEDS_SESSION':
    case 'NOT_ENROLLED':
    case 'KEY_LOCKED':
      return 423;
    case 'NO_VAULT':
    case 'DECRYPTION_ERROR':
    case 'internal':
      return 500;
    case 'MIGRATION_UNAVAILABLE':
      return 503;
  }
}

export function sendError(
  response: ServerResponse,
  type: DelegateErrorType,
  message?: string
): void {
  sendJson(response, statusForError(type), { error: { type, message } });
}
