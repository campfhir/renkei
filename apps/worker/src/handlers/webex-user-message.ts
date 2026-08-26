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
 * The one hard guard: messages RENKEI SENT are skipped, matched by id
 * against the `webex_sent_messages` ledger. Renkei posts as the user — an
 * agent replying in a space, a note to self, a confirmed send all carry the
 * watcher's own token — so those posts return through the watcher's webhook
 * and reacting to them would loop the pipeline against itself.
 *
 * This used to skip everything the watcher AUTHORED, which stopped the loop
 * by also throwing away every message the person actually typed. Their own
 * messages are content their own agents should be able to trigger on and
 * their own knowledge index should hold — a thread indexed with one side of
 * the conversation missing does not read as a conversation.
 */

import { getDatabase } from '@renkei/db';
import { WebexClient } from '@renkei/connector-webex';
import type { ClaimedEvent } from '../queue';
import type { EventHandler } from '../handlers';
import { resolveWebexUserAccessByAccount } from './webex-linked-user';
import { publishDomainEvent, BODY_PREVIEW_CHARS } from '../domain-events';
import { logger } from '../logger';

/**
 * Did Renkei post this message itself?
 *
 * Throws when the ledger cannot be read, rather than guessing. Guessing
 * "no" re-enters the loop this guard exists to prevent; guessing "yes"
 * silently drops a real message. Throwing hands the row back to the queue,
 * which retries — and a database this handler cannot read is a database the
 * rest of the pipeline cannot use either.
 */
async function wasSentByRenkei(tenantId: string, messageId: string): Promise<boolean> {
  const dbResult = getDatabase();
  if (!dbResult.ok) throw new Error('database unavailable for the WebEx sent-message ledger');
  const row = await dbResult.val
    .selectFrom('webex_sent_messages')
    .select('message_id')
    .where('tenant_id', '=', tenantId)
    .where('message_id', '=', messageId)
    .executeTakeFirst();
  return row !== undefined;
}

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
    /** Injectable so a test can drive the loop guard without a database. */
    wasSentByRenkei?: (tenantId: string, messageId: string) => Promise<boolean>;
  } = {}
): EventHandler {
  const resolveAccess = deps.resolveAccess ?? resolveWebexUserAccessByAccount;
  const makeClient = deps.makeClient ?? ((token: string) => new WebexClient(token));
  const publish = deps.publish ?? publishDomainEvent;
  const wasSent = deps.wasSentByRenkei ?? wasSentByRenkei;

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

    // The loop guard, by identity rather than by authorship: a message
    // Renkei itself posted (as this user) must not re-enter the pipeline
    // that may have posted it. Anything else — including messages the
    // watcher typed themselves — goes through.
    if (await wasSent(event.tenant_id, message.id)) {
      logger.debug('skipping a message Renkei sent: {messageId}', {
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
      // The WATCHER — the user whose all-spaces webhook delivered this,
      // which is who the event is FOR. Often not the sender, and sometimes
      // the same person: a watcher's own messages reach their own agents
      // and their own index, and only what Renkei posted is held back.
      ownerSubject: access.subject,
      data: {
        text: message.text.slice(0, BODY_PREVIEW_CHARS),
        sender: message.personEmail ?? '',
        roomId: message.roomId,
        // 'direct' or 'group' per WebEx; '' when the API omits it, which a
        // space-type filter then fails closed on (see trigger-filters.ts).
        roomType: message.roomType ?? '',
        messageId: message.id,
      },
      occurredAt: message.created ?? undefined,
      orderingKey: `webex/${event.tenant_id}/${payload.accountId}/${message.roomId}`,
    });
  };
}
