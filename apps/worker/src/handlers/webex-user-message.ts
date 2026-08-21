/**
 * The webex/user-message.created handler — deliveries from a user's own
 * all-spaces webhook (opt-in on the connectors page; there is no bot).
 *
 * The delivery names the WATCHER (accountId) and the message; this handler
 * fetches the message with the watcher's own token, then publishes it as a
 * `webex/message.received` domain event scoped to the watcher. What
 * happens next is dispatch configuration (handlers/domain-dispatch.ts) —
 * knowledge indexing, the watcher's agent triggers — not this handler's
 * concern. Each opted-in user is an independent stream, so two users
 * sharing a space each publish exactly their own event, never duplicates
 * of each other's.
 *
 * The one hard guard: messages the watcher AUTHORED are skipped. Automated
 * replies post with the watcher's own token, so those replies are
 * watcher-authored — reacting to them would loop the pipeline against
 * itself.
 */

import { WebexClient } from '@renkei/connector-webex';
import type { ClaimedEvent } from '../queue';
import type { EventHandler } from '../handlers';
import { resolveWebexUserAccessByAccount } from './webex-linked-user';
import { publishDomainEvent, BODY_PREVIEW_CHARS } from '../domain-events';
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
    publish?: typeof publishDomainEvent;
  } = {}
): EventHandler {
  const resolveAccess = deps.resolveAccess ?? resolveWebexUserAccessByAccount;
  const makeClient = deps.makeClient ?? ((token: string) => new WebexClient(token));
  const publish = deps.publish ?? publishDomainEvent;

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
      return 'skipped';
    }

    const messageResult = await makeClient(access.accessToken).getMessage(payload.messageId);
    if (!messageResult.ok) {
      throw new Error(`could not fetch WebEx message ${payload.messageId}`);
    }
    const message = messageResult.val;

    // The loop guard: the watcher's own messages (including automated
    // replies, which post as them) never re-enter their own pipeline.
    if (message.personId === payload.accountId) {
      logger.debug('skipping the watcher’s own message {messageId}', {
        component: 'webex/user-ingest',
        messageId: message.id,
      });
      return 'skipped';
    }
    if (!message.text) return 'skipped';

    await publish({
      tenantId: event.tenant_id,
      provider: 'webex',
      type: 'message.received',
      // The WATCHER — the user whose all-spaces webhook delivered this.
      // Not the sender: the whole point of watching a space is reacting
      // to OTHER people's messages.
      ownerSubject: access.subject,
      data: {
        text: message.text.slice(0, BODY_PREVIEW_CHARS),
        sender: message.personEmail ?? '',
        roomId: message.roomId,
        messageId: message.id,
      },
      occurredAt: message.created ?? undefined,
      orderingKey: `webex/${event.tenant_id}/${payload.accountId}/${message.roomId}`,
    });
  };
}
