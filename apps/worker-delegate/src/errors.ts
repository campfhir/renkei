/**
 * The delegate's error vocabulary: the generic worker tags plus every
 * verdict @renkei/user-keys can hand back, so a caller hears the same
 * word the key store said and can act on it (`KEY_LOCKED` is the one the
 * chat page turns into "unlock it in Preferences").
 */

import type { ServerResponse } from 'node:http';
import type { GenericWorkerError } from '@renkei/worker-kit';
import { sendJson } from '@renkei/worker-kit';

export type DelegateErrorType =
  | GenericWorkerError
  // @renkei/user-keys: KekError
  | 'MISSING_USER_KEY_MASTER'
  | 'INVALID_ENCRYPTION_KEY'
  | 'NO_USER_KEY'
  | 'KEY_LOCKED'
  // OpenKeyError
  | 'NO_KEY'
  | 'NO_ACCESS'
  | 'DECRYPTION_ERROR'
  // own-key moves
  | 'PASSPHRASE_TOO_SHORT'
  | 'PASSPHRASE_TOO_LONG'
  | 'NOT_OWN_KEY'
  | 'NOT_MANAGED'
  | 'WRONG_PASSPHRASE';

export function statusForError(type: DelegateErrorType): number {
  switch (type) {
    case 'bad_request':
    case 'PASSPHRASE_TOO_SHORT':
    case 'PASSPHRASE_TOO_LONG':
      return 400;
    case 'unauthorized':
      return 401;
    case 'NO_ACCESS':
    case 'WRONG_PASSPHRASE':
      return 403;
    case 'unknown_operation':
    case 'NO_KEY':
    case 'NO_USER_KEY':
      return 404;
    case 'method_not_allowed':
      return 405;
    case 'NOT_OWN_KEY':
    case 'NOT_MANAGED':
      return 409;
    case 'too_large':
      return 413;
    case 'KEY_LOCKED':
      return 423;
    case 'MISSING_USER_KEY_MASTER':
    case 'INVALID_ENCRYPTION_KEY':
    case 'DECRYPTION_ERROR':
    case 'internal':
      return 500;
  }
}

export function sendError(
  response: ServerResponse,
  type: DelegateErrorType,
  message?: string
): void {
  sendJson(response, statusForError(type), { error: { type, message } });
}
