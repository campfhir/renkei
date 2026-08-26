/**
 * The injected ACL resolver for the fileshare_* tools — the GraphAuth
 * shape, with Renkei's own store standing where a provider's OAuth would.
 * Resolution happens FRESH ON EVERY CALL (a tool registered at connect
 * time may run an hour later, and an admin may have narrowed a grant in
 * between); nothing here is captured at registration, which also keeps
 * registration free of I/O for the tool-catalog collector.
 *
 * Since the fileshare worker took over all share I/O, this resolver is
 * CONTEXT-ONLY: it never touches credentials — the worker is the only
 * process that decrypts them. What remains here serves the tools that
 * answer from the store alone (discovery, and the pre-flight check when
 * minting an upload slot).
 *
 * Refusals are user-visible strings, and the "no such share" and "no
 * grant on that share" cases share one string on purpose: a caller
 * without a grant must not be able to distinguish a share that exists
 * from one that does not.
 */

import { getDatabase } from '@renkei/db';
import { getAclContext, listGrantedShares } from '@renkei/connector-fileshares';
import type { AclContext, GrantedShare } from '@renkei/connector-fileshares';
import type { MCPToolContext } from '../common';

export const NO_SUCH_SHARE =
  'No file share with that id is available to you. fileshare_list_shares shows what is.';

export const NO_STORED_CREDENTIALS =
  'This share has no stored credentials yet — an administrator must finish its setup.';

const NOT_AVAILABLE = 'File shares are not available for this caller.';

export interface ResolvedShare {
  ctx: AclContext;
}

export interface FileshareAuth {
  readonly kind: 'user' | 'denied';
  /** The tenant/subject the tools act as; a string is a user-visible refusal. */
  target(): { tenantId: string; subject: string } | string;
  /** The shares this caller may see. A string is a user-visible refusal. */
  listGranted(): Promise<GrantedShare[] | string>;
  /** The ACL context for one share, or a refusal. */
  resolve(shareId: string): Promise<ResolvedShare | string>;
}

export function userFileshareAuth(context: MCPToolContext): FileshareAuth {
  return {
    kind: 'user',
    target() {
      const subject = context.subject;
      if (!subject) return NOT_AVAILABLE;
      return { tenantId: context.tenantId, subject };
    },

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
      if (!ctx.val.share.hasCredentials) return NO_STORED_CREDENTIALS;
      return { ctx: ctx.val };
    },
  };
}

/** For test suites that register the tools with no live store behind them. */
export function deniedFileshareAuth(): FileshareAuth {
  return {
    kind: 'denied',
    target() {
      return NOT_AVAILABLE;
    },
    async listGranted() {
      return NOT_AVAILABLE;
    },
    async resolve() {
      return NOT_AVAILABLE;
    },
  };
}
