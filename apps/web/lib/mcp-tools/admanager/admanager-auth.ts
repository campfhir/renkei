/**
 * The injected resolver for the admanager_* tools — the fileshare-auth /
 * mirth-auth shape, with the caller's own stored ADManager Plus
 * connections standing where a provider's OAuth would. Resolution happens
 * FRESH ON EVERY CALL (a tool registered at connect time may run an hour
 * later, and the person may have disconnected or narrowed their exposure
 * in between); nothing here is captured at registration, which also keeps
 * registration free of I/O for the tool-catalog collector.
 *
 * This resolver is CONTEXT-ONLY: it never touches credentials — the
 * ADManager Plus worker is the only process that decrypts them. What it
 * answers is discovery (which instances the caller connected) and the
 * caller's own LLM-exposure choice, which the tools enforce per call:
 * exposure can hide access the person holds, and can never mint any —
 * ADManager Plus's own token scope and the technician's delegated rights
 * have the final word on every operation.
 */

import { getDatabase } from '@renkei/db';
import { getConnection, listConnectedInstances } from '@renkei/connector-admanager';
import type { ConnectedInstance, InstanceConnection } from '@renkei/connector-admanager';
import type { MCPToolContext } from '../common';

export const NO_SUCH_INSTANCE =
  'No ADManager Plus instance with that id is connected for you. admanager_list_instances shows ' +
  'what is, and the Connectors page in Renkei is where an instance gets connected.';

const NOT_AVAILABLE = 'ADManager Plus is not available for this caller.';

export interface AdManagerAuth {
  readonly kind: 'user' | 'denied';
  /** The tenant/subject the tools act as; a string is a user-visible refusal. */
  target(): { tenantId: string; subject: string } | string;
  /** The instances this caller has connected. A string is a user-visible refusal. */
  listConnected(): Promise<ConnectedInstance[] | string>;
  /** The caller's connection (exposure choice) on one instance, or a refusal. */
  connection(instanceId: string): Promise<InstanceConnection | string>;
}

export function userAdManagerAuth(context: MCPToolContext): AdManagerAuth {
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
      const connected = await listConnectedInstances(dbResult.val, context.tenantId, subject);
      if (!connected.ok) return 'Could not read your ADManager Plus connections.';
      return connected.val;
    },

    async connection(instanceId: string) {
      const subject = context.subject;
      if (!subject) return NOT_AVAILABLE;
      const dbResult = getDatabase();
      if (!dbResult.ok) return 'Database unavailable.';
      const connection = await getConnection(dbResult.val, context.tenantId, instanceId, subject);
      if (!connection.ok) return 'Could not read your ADManager Plus connections.';
      if (!connection.val) return NO_SUCH_INSTANCE;
      return connection.val;
    },
  };
}

/** For test suites that register the tools with no live store behind them. */
export function deniedAdManagerAuth(): AdManagerAuth {
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
