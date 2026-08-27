/**
 * The injected resolver for the fileshare_* tools — the GraphAuth shape,
 * with the caller's own stored share connections standing where a
 * provider's OAuth would. Resolution happens FRESH ON EVERY CALL (a tool
 * registered at connect time may run an hour later, and the person may
 * have disconnected or narrowed their exposure in between); nothing here
 * is captured at registration, which also keeps registration free of I/O
 * for the tool-catalog collector.
 *
 * This resolver is CONTEXT-ONLY: it never touches credentials — the
 * fileshare worker is the only process that decrypts them. What it answers
 * is discovery (which shares the caller connected) and the caller's own
 * LLM-exposure choice, which the tools enforce per call: exposure can hide
 * access the person holds, and can never mint any — the file server has
 * the final word on every operation.
 */

import { getDatabase } from '@renkei/db';
import { getConnection, listConnectedShares } from '@renkei/connector-fileshares';
import type { ConnectedShare, ShareConnection } from '@renkei/connector-fileshares';
import type { MCPToolContext } from '../common';

export const NO_SUCH_SHARE =
  'No file share with that id is connected for you. fileshare_list_shares shows what is, ' +
  'and the Connectors page in Renkei is where a share gets connected.';

const NOT_AVAILABLE = 'File shares are not available for this caller.';

export interface FileshareAuth {
  readonly kind: 'user' | 'denied';
  /** The tenant/subject the tools act as; a string is a user-visible refusal. */
  target(): { tenantId: string; subject: string } | string;
  /** The shares this caller has connected. A string is a user-visible refusal. */
  listConnected(): Promise<ConnectedShare[] | string>;
  /** The caller's connection (exposure choice) on one share, or a refusal. */
  connection(shareId: string): Promise<ShareConnection | string>;
}

export function userFileshareAuth(context: MCPToolContext): FileshareAuth {
  return {
    kind: 'user',
    target() {
      const subject = context.subject;
      if (!subject) return NOT_AVAILABLE;
      return { tenantId: context.tenantId, subject };
    },

    async listConnected() {
      const subject = context.subject;
      if (!subject) return NOT_AVAILABLE;
      const dbResult = getDatabase();
      if (!dbResult.ok) return 'Database unavailable.';
      const connected = await listConnectedShares(dbResult.val, context.tenantId, subject);
      if (!connected.ok) return 'Could not read your share connections.';
      return connected.val;
    },

    async connection(shareId: string) {
      const subject = context.subject;
      if (!subject) return NOT_AVAILABLE;
      const dbResult = getDatabase();
      if (!dbResult.ok) return 'Database unavailable.';
      const connection = await getConnection(dbResult.val, context.tenantId, shareId, subject);
      if (!connection.ok) return 'Could not read your share connections.';
      if (!connection.val) return NO_SUCH_SHARE;
      return connection.val;
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
    async listConnected() {
      return NOT_AVAILABLE;
    },
    async connection() {
      return NOT_AVAILABLE;
    },
  };
}
