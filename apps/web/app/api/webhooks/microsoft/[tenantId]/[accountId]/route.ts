/**
 * Microsoft Graph change-notification receipt — deliberately thin
 * (RENKEI.md Decision #17): authenticate the delivery, INSERT event rows,
 * 202. All processing happens in the worker, which runs a delta round —
 * notification ids are routing hints, never content.
 *
 * The URL carries BOTH the tenant and the grant's account id: Graph
 * subscriptions are per-user, and each subscription's notificationUrl is
 * minted with its owner in the path, so a delivery routes straight to the
 * owning grant and anything that does not line up is dropped.
 *
 * Graph does not sign notifications. Authenticity rests on two things:
 * the validationToken handshake at subscription time (echoed below within
 * Graph's 10-second deadline), and the per-subscription clientState secret
 * compared on every delivery against the webhook_subscriptions row.
 * Lifecycle notifications (reauthorizationRequired, subscriptionRemoved,
 * missed) point at this same route and become their own event type.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { webhookEventsQueue } from '@renkei/queue';
import { logger } from '@/lib/logger';

const MICROSOFT_SOURCE = 'microsoft';
const eventsQueue = webhookEventsQueue();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; accountId: string }> }
): Promise<NextResponse> {
  const { tenantId, accountId } = await params;

  // Subscription-creation handshake: echo the token as text/plain, fast,
  // before any database work — Graph abandons the subscription after 10s.
  const validationToken = new URL(request.url).searchParams.get('validationToken');
  if (validationToken !== null) {
    return new NextResponse(validationToken, {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  let body: unknown;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return NextResponse.json({ error: 'Malformed JSON body' }, { status: 400 });
  }
  const notifications = isRecord(body) && Array.isArray(body.value) ? body.value : [];
  if (notifications.length === 0) {
    return NextResponse.json({ accepted: 0 }, { status: 202 });
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    // 500 so Graph retries the delivery instead of dropping it.
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }
  const db = dbResult.val;

  // Every subscription this route can legitimately hear about: this
  // tenant's, this account's. A delivery naming any other subscription is
  // either stale or forged, and is dropped either way.
  const subscriptionRows = await db
    .selectFrom('webhook_subscriptions')
    .select(['subscription_id', 'client_state'])
    .where('tenant_id', '=', tenantId)
    .where('provider', '=', MICROSOFT_SOURCE)
    .where('account_id', '=', accountId)
    .execute();
  const clientStateBySubscription = new Map<string, string>();
  for (const row of subscriptionRows) {
    if (row.subscription_id !== null) {
      clientStateBySubscription.set(row.subscription_id, row.client_state);
    }
  }

  let accepted = 0;
  for (const notification of notifications) {
    if (!isRecord(notification)) continue;
    const subscriptionId =
      typeof notification.subscriptionId === 'string' ? notification.subscriptionId : null;
    const clientState =
      typeof notification.clientState === 'string' ? notification.clientState : null;
    if (!subscriptionId || clientStateBySubscription.get(subscriptionId) !== clientState) {
      logger.warn('Dropped Graph notification with unknown subscription or clientState mismatch', {
        component: 'microsoft/webhook',
        tenantId,
        subscriptionId: subscriptionId ?? '(none)',
      });
      continue;
    }

    const lifecycleEvent =
      typeof notification.lifecycleEvent === 'string' ? notification.lifecycleEvent : null;
    const resourceData = isRecord(notification.resourceData) ? notification.resourceData : {};

    const enqueued = await eventsQueue.producer.enqueue({
      tenantId,
      source: MICROSOFT_SOURCE,
      type: lifecycleEvent ? 'lifecycle' : 'change-notification',
      payload: {
        accountId,
        subscriptionId,
        lifecycleEvent,
        resource: typeof notification.resource === 'string' ? notification.resource : null,
        changeType: typeof notification.changeType === 'string' ? notification.changeType : null,
        // A routing hint only: the worker re-syncs via delta, never by
        // trusting ids delivered over the network.
        resourceId: typeof resourceData.id === 'string' ? resourceData.id : null,
      },
      // One subscription's delta rounds run in order — two workers must not
      // race the same delta cursor.
      orderingKey: `microsoft/${accountId}/${subscriptionId}`,
    });
    if (enqueued.ok) accepted += 1;
  }

  logger.debug('Graph notifications accepted', {
    component: 'microsoft/webhook',
    tenantId,
    accepted,
    delivered: notifications.length,
  });
  return NextResponse.json({ accepted }, { status: 202 });
}
