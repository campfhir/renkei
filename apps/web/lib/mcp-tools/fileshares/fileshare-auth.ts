/**
 * The injected credential/ACL resolver for the fileshare_* tools — the
 * GraphAuth shape, with Renkei's own store standing where a provider's
 * OAuth would. Resolution happens FRESH ON EVERY CALL (a tool registered
 * at connect time may run an hour later, and an admin may have narrowed a
 * grant in between); nothing here is captured at registration, which also
 * keeps registration free of I/O for the tool-catalog collector.
 *
 * Refusals are user-visible strings, and the "no such share" and "no
 * grant on that share" cases share one string on purpose: a caller
 * without a grant must not be able to distinguish a share that exists
 * from one that does not.
 */

import { parseEncryptionKey } from '@renkei/crypto';
import { getDatabase } from '@renkei/db';
import {
  decryptCredentials,
  getAclContext,
  listGrantedShares,
  readCredentialCiphertext,
} from '@renkei/connector-fileshares';
import type { AclContext, GrantedShare, ShareCredentials } from '@renkei/connector-fileshares';
import type { MCPToolContext } from '../common';

export const NO_SUCH_SHARE =
  'No file share with that id is available to you. fileshare_list_shares shows what is.';

const NOT_AVAILABLE = 'File shares are not available for this caller.';

export interface ResolvedShare {
  ctx: AclContext;
  credentials: ShareCredentials;
}

export interface FileshareAuth {
  readonly kind: 'user' | 'denied';
  /** The shares this caller may see. A string is a user-visible refusal. */
  listGranted(): Promise<GrantedShare[] | string>;
  /** Full ACL context + decrypted credential for one share, or a refusal. */
  resolve(shareId: string): Promise<ResolvedShare | string>;
}

export function userFileshareAuth(context: MCPToolContext): FileshareAuth {
  return {
    kind: 'user',
    async listGranted() {
      const subject = context.subject;
      if (!subject) return NOT_AVAILABLE;
      const dbResult = getDatabase();
      if (!dbResult.ok) return 'Database unavailable.';
      const granted = await listGrantedShares(dbResult.val, context.tenantId, subject);
      if (!granted.ok) return 'Could not read your file share access.';
      return granted.val;
    },

    async resolve(shareId: string) {
      const subject = context.subject;
      if (!subject) return NOT_AVAILABLE;
      const dbResult = getDatabase();
      if (!dbResult.ok) return 'Database unavailable.';

      const ctx = await getAclContext(dbResult.val, context.tenantId, shareId, subject);
      if (!ctx.ok) return 'Could not read your file share access.';
      if (!ctx.val) return NO_SUCH_SHARE;
      if (!ctx.val.share.enabled) return NO_SUCH_SHARE;
      if (!ctx.val.share.hasCredentials) {
        return 'This share has no stored credentials yet — an administrator must finish its setup.';
      }

      const key = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
      if (!key.ok) return 'The server cannot open stored credentials.';
      const ciphertext = await readCredentialCiphertext(dbResult.val, context.tenantId, shareId);
      if (!ciphertext.ok || ciphertext.val === null) {
        return 'This share has no stored credentials yet — an administrator must finish its setup.';
      }
      const credentials = decryptCredentials(ciphertext.val, key.val);
      if (!credentials.ok) {
        return 'The stored credentials for this share cannot be read — an administrator must re-enter them.';
      }
      return { ctx: ctx.val, credentials: credentials.val };
    },
  };
}

/** For test suites that register the tools with no live store behind them. */
export function deniedFileshareAuth(): FileshareAuth {
  return {
    kind: 'denied',
    async listGranted() {
      return NOT_AVAILABLE;
    },
    async resolve() {
      return NOT_AVAILABLE;
    },
  };
}
