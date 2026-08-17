/**
 * The webex/user-message.created handler — deliveries from a user's own
 * all-spaces webhook (opt-in on the connectors page; there is no bot).
 *
 * The delivery names the WATCHER (accountId) and the message; the message
 * is fetched with the watcher's own token and fans into the WATCHER's
 * agent triggers only — each opted-in user is an independent stream, so
 * two users sharing a space each get exactly their own runs, never
 * duplicates of each other's.
 *
 * The one hard guard: messages the watcher AUTHORED are skipped. Agent
 * replies post with the watcher's own token, so their replies are
 * watcher-authored — acting on them would loop an agent against itself.
 */

import { WebexClient } from '@renkei/connector-webex';
import type { ClaimedEvent } from '../queue';
import type { EventHandler } from '../handlers';
import { resolveWebexUserAccessByAccount } from './webex-linked-user';
import { fanOutWebexMessage } from './agent-triggers';
import { logger } from '../logger';

function payloadOf(event: ClaimedEvent): { messageId: string; accountId: string } | null {
  const payload: unknown = event.payload;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const record: { id?: unknown; accountId?: unknown } = payload;
  if (typeof record.id !== 'string' || !record.id) return null;
  if (typeof record.accountId !== 'string' || !record.accountId) return null;
  return { messageId: record.id, accountId: record.accountId };
}

export function createWebexUserMessageHandler(
  deps: {
    resolveAccess?: typeof resolveWebexUserAccessByAccount;
    makeClient?: (accessToken: string) => Pick<WebexClient, 'getMessage'>;
  } = {}
): EventHandler {
  const resolveAccess = deps.resolveAccess ?? resolveWebexUserAccessByAccount;
  const makeClient = deps.makeClient ?? ((token: string) => new WebexClient(token));

  return async (event) => {
    const payload = payloadOf(event);
    if (!payload) throw new Error('webex user-message payload missing id/accountId');

    const access = await resolveAccess(event.tenant_id, payload.accountId);
    if (!access) {
      // Grant revoked or unreadable — nothing to act as. The registration
      // itself rots away via 404s on the receipt route.
      logger.warn('no usable grant for all-spaces delivery; dropping', {
        component: 'webex/user-ingest',
        tenantId: event.tenant_id,
      });
      return;
    }

    const messageResult = await makeClient(access.accessToken).getMessage(payload.messageId);
    if (!messageResult.ok) {
      throw new Error(`could not fetch WebEx message ${payload.messageId}`);
    }
    const message = messageResult.val;

    // The loop guard: the watcher's own messages (including their agents'
    // replies, which post as them) never trigger their own agents.
    if (message.personId === payload.accountId) {
      logger.debug('skipping the watcher’s own message {messageId}', {
        component: 'webex/user-ingest',
        messageId: message.id,
      });
      return;
    }
    if (!message.text) return;

    const started = await fanOutWebexMessage({
      tenantId: event.tenant_id,
      ownerSubject: access.subject,
      senderEmail: message.personEmail ?? '',
      messageId: message.id,
      roomId: message.roomId,
      text: message.text,
    });
    logger.debug('{count} agent run(s) started for {messageId}', {
      component: 'webex/user-ingest',
      messageId: message.id,
      count: started,
    });
  };
}
