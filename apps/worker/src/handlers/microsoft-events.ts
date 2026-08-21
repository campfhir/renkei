/**
 * The microsoft/* event handlers.
 *
 * grant.connected — the connect-time bootstrap: create the grant's Graph
 * subscriptions and run the initial delta backfill. Enqueued by the OAuth
 * callback because the subscription handshake calls our webhook route
 * synchronously and the backfill is minutes of work, not callback work.
 *
 * change-notification — the ingestion workhorse: a notification names a
 * subscription; the handler runs a delta round from that row's cursor.
 * Notification ids are hints; delta is the truth.
 *
 * lifecycle — Graph's own health channel: reauthorizationRequired renews
 * now; subscriptionRemoved clears the row so ensure recreates it.
 */

import { getDatabase } from '@renkei/db';
import { getPublicBaseUrl } from '@renkei/settings';
import { renewGraphSubscription, graphRequest } from '@renkei/connector-microsoft';
import { MICROSOFT } from '@renkei/provider-grants';
import { resolveEmbeddingProvider } from '@renkei/knowledge';
import type { MessageOverride } from '@renkei/email-sanitizer';
import { sql } from 'kysely';
import { enqueueKnowledgeEvent } from '../enqueue';
import type { ClaimedEvent } from '../queue';
import type { EventHandler } from '../handlers';
import { resolveMicrosoftAccess } from './microsoft-access';
import { ensureMicrosoftSubscriptions, runSubscriptionSync, rawEmailOf } from './microsoft-sync';
import { logger } from '../logger';

const COMPONENT = 'microsoft/events';

function payloadOf(event: ClaimedEvent): Record<string, unknown> {
  const payload: unknown = event.payload;
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? { ...payload }
    : {};
}

function requireString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || !value) {
    throw new Error(`microsoft event payload has no ${key}`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isOverrideAction(value: string): value is MessageOverride['action'] {
  return value === 'exclude' || value === 'reclassify';
}

function isEmailCategory(value: string): value is NonNullable<MessageOverride['category']> {
  return value === 'human' || value === 'system_notification' || value === 'marketing';
}

function requireOverride(payload: Record<string, unknown>): MessageOverride {
  const raw = payload.override;
  if (!isRecord(raw) || typeof raw.action !== 'string' || !isOverrideAction(raw.action)) {
    throw new Error('microsoft message-override event payload has no valid override.action');
  }
  return {
    action: raw.action,
    category:
      typeof raw.category === 'string' && isEmailCategory(raw.category) ? raw.category : undefined,
    senderKey: typeof raw.senderKey === 'string' ? raw.senderKey : undefined,
  };
}

export function createMicrosoftGrantConnectedHandler(): EventHandler {
  return async (event) => {
    const payload = payloadOf(event);
    const accountId = requireString(payload, 'accountId');
    const tenantId = event.tenant_id;

    const baseUrl = getPublicBaseUrl();
    if (!baseUrl) {
      // Retryable on purpose: once an operator sets the public base URL the
      // retry (or the sweep) completes the bootstrap.
      throw new Error('public base URL not set; cannot mint Graph notification URLs');
    }

    const access = await resolveMicrosoftAccess(tenantId, accountId);
    const rows = await ensureMicrosoftSubscriptions(tenantId, access, baseUrl);

    // Initial backfill: one bounded delta round per resource. Idempotent —
    // a retry after a partial pass re-runs into upserts.
    let indexed = 0;
    for (const row of rows) {
      const synced = await runSubscriptionSync(tenantId, access, row);
      indexed += synced.changed;
    }
    logger.info('microsoft bootstrap complete: {subscriptions} subscriptions, {indexed} objects', {
      component: COMPONENT,
      tenantId,
      subscriptions: rows.length,
      indexed,
    });
  };
}

export function createMicrosoftChangeNotificationHandler(): EventHandler {
  return async (event) => {
    const payload = payloadOf(event);
    const accountId = requireString(payload, 'accountId');
    const subscriptionId = requireString(payload, 'subscriptionId');
    const tenantId = event.tenant_id;

    const dbResult = getDatabase();
    if (!dbResult.ok) throw new Error('database unavailable');
    const row = await dbResult.val
      .selectFrom('webhook_subscriptions')
      .select(['id', 'resource', 'subscription_id', 'client_state', 'expires_at', 'delta_link'])
      .where('tenant_id', '=', tenantId)
      .where('provider', '=', MICROSOFT)
      .where('account_id', '=', accountId)
      .where('subscription_id', '=', subscriptionId)
      .executeTakeFirst();
    if (!row) {
      // Disconnected between delivery and processing — nothing to sync.
      logger.info('notification for a subscription that no longer exists; dropping', {
        component: COMPONENT,
        tenantId,
        subscriptionId,
      });
      return 'skipped';
    }

    const access = await resolveMicrosoftAccess(tenantId, accountId);
    const synced = await runSubscriptionSync(tenantId, access, row);
    logger.debug('delta round for {resource}: {changed} changed, {removed} removed', {
      component: COMPONENT,
      tenantId,
      resource: row.resource,
      changed: synced.changed,
      removed: synced.removed,
    });
  };
}

export function createMicrosoftLifecycleHandler(): EventHandler {
  return async (event) => {
    const payload = payloadOf(event);
    const accountId = requireString(payload, 'accountId');
    const subscriptionId = requireString(payload, 'subscriptionId');
    const lifecycleEvent = typeof payload.lifecycleEvent === 'string' ? payload.lifecycleEvent : '';
    const tenantId = event.tenant_id;

    const dbResult = getDatabase();
    if (!dbResult.ok) throw new Error('database unavailable');
    const db = dbResult.val;

    if (lifecycleEvent === 'reauthorizationRequired') {
      const access = await resolveMicrosoftAccess(tenantId, accountId);
      const renewed = await renewGraphSubscription(access.accessToken, subscriptionId);
      if (renewed.ok) {
        await db
          .updateTable('webhook_subscriptions')
          .set({ expires_at: renewed.val.expiresAt, updated_at: sql`NOW()` })
          .where('tenant_id', '=', tenantId)
          .where('provider', '=', MICROSOFT)
          .where('subscription_id', '=', subscriptionId)
          .execute();
        return;
      }
      // Renewal refused — fall through to the removed path so the sweep
      // recreates from scratch.
      logger.warn('reauthorization renewal failed; clearing for recreate', {
        component: COMPONENT,
        tenantId,
        subscriptionId,
      });
    }

    // subscriptionRemoved / missed / failed renewal: clear the provider-side
    // identity so the next ensure pass (sweep, or the next connect) creates
    // a fresh subscription. The delta cursor survives — no re-backfill.
    await db
      .updateTable('webhook_subscriptions')
      .set({ subscription_id: null, expires_at: null, updated_at: sql`NOW()` })
      .where('tenant_id', '=', tenantId)
      .where('provider', '=', MICROSOFT)
      .where('subscription_id', '=', subscriptionId)
      .execute();
    logger.warn('lifecycle {lifecycleEvent}: subscription cleared for recreate', {
      component: COMPONENT,
      tenantId,
      lifecycleEvent: lifecycleEvent || '(unknown)',
    });
  };
}

/**
 * message-override — a mailbox owner's own correction from their private
 * mail-review page (never admin-initiated; see packages/email-sanitizer's
 * persistence/log.ts for why). Message bodies are never persisted at rest,
 * so applying an override means re-fetching the one message from Graph,
 * running it back through the pipeline with the override forced, and
 * re-indexing or removing accordingly. 'exclude' needs no re-fetch — there
 * is nothing left to sanitize, only a chunk to remove.
 */
export function createMicrosoftMessageOverrideHandler(): EventHandler {
  return async (event) => {
    const payload = payloadOf(event);
    const accountId = requireString(payload, 'accountId');
    const objectId = requireString(payload, 'objectId');
    const refId = requireString(payload, 'refId');
    const override = requireOverride(payload);
    const tenantId = event.tenant_id;

    // The same mailbox-kind ordering key runSubscriptionSync uses — refIds
    // are `${upn}/${kind}/${objectId}`, so the first two segments name the
    // sequence this message's index writes must keep.
    const orderingKey = `microsoft/${refId.split('/').slice(0, 2).join('/')}`;

    if (override.action === 'exclude') {
      // Through the embedding queue, not inline: if an ingest of this same
      // message is still queued there, the shared ordering key puts this
      // delete after it — an inline delete could run first and lose the race.
      await enqueueKnowledgeEvent(
        tenantId,
        'delete.object',
        { provider: MICROSOFT, refId },
        orderingKey
      );
      return;
    }

    const access = await resolveMicrosoftAccess(tenantId, accountId);
    const embedder = await resolveEmbeddingProvider(tenantId);
    if (!embedder) {
      logger.warn('message-override skipped: knowledge layer is off for this org', {
        component: COMPONENT,
        tenantId,
      });
      return;
    }

    const fetched = await graphRequest(access.accessToken, `/me/messages/${objectId}`);
    if (!fetched.ok || !isRecord(fetched.val)) {
      throw new Error(`could not re-fetch message ${objectId} for override (tenant ${tenantId})`);
    }

    // The sanitize-and-ingest runs in the embedding queue (Decision #20);
    // the override rides the payload so the queue's handler forces it through
    // the pipeline there. The re-fetch stays here — it is bounded Graph I/O
    // and the message body must not sit in the queue longer than needed.
    //
    // Carry the same descriptive metadata the automatic sync path writes
    // (microsoft-sync.ts). Omitting `when`/`subject`/`webLink` here made an
    // overridden message invisible to any date filter and title-less in the
    // UI — the correction the owner just made would quietly downgrade the
    // record instead of improving it.
    const received = str(fetched.val.receivedDateTime);
    await enqueueKnowledgeEvent(
      tenantId,
      'ingest.email',
      {
        provider: MICROSOFT,
        refId,
        ownerUpn: access.upn,
        accountId,
        raw: rawEmailOf(fetched.val),
        override,
        metadata: {
          kind: 'msg',
          upn: access.upn,
          webLink: str(fetched.val.webLink) || undefined,
          when: received || undefined,
          subject: str(fetched.val.subject) || undefined,
          overridden: true,
        },
        sourceAt: received || null,
      },
      orderingKey
    );
  };
}
