/**
 * Per-user WebEx webhook receipt — the all-spaces registration made with
 * the user's OWN token (there is no bot). Deliberately thin (RENKEI.md
 * Decision #17): verify the signature over the raw bytes against the
 * grant's own per-user secret, validate shape, enqueue; the worker fetches
 * the message with the same user's token and publishes it as a domain
 * event for dispatch to its subscribers.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { webhookEventsQueue } from '@renkei/queue';
import { WEBEX_USER } from '@renkei/provider-grants';
import { verifyWebexSignature, parseWebhookPayload } from '@renkei/connector-webex';
import { logger } from '@/lib/logger';

const eventsQueue = webhookEventsQueue();

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; accountId: string }> }
): Promise<NextResponse> {
  const { tenantId, accountId } = await params;

  const rawBody = await request.text();
  const signature = request.headers.get('x-spark-signature') ?? '';

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    // 500 so WebEx retries instead of dropping the delivery.
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }

  const grant = await dbResult.val
    .selectFrom('provider_grants')
    .select(['metadata', 'subject'])
    .where('tenant_id', '=', tenantId)
    .where('provider', '=', WEBEX_USER)
    .where('provider_account_id', '=', accountId)
    .executeTakeFirst();
  const metadata: { allSpaces?: unknown; allSpacesSecret?: unknown } =
    typeof grant?.metadata === 'object' && grant.metadata !== null && !Array.isArray(grant.metadata)
      ? grant.metadata
      : {};
  if (!grant || metadata.allSpaces !== true || typeof metadata.allSpacesSecret !== 'string') {
    // 404 rather than 503: a webhook for a revoked/opted-out grant should
    // die (WebEx deactivates persistently-failing registrations).
    return NextResponse.json({ error: 'No such registration' }, { status: 404 });
  }

  if (!verifyWebexSignature(rawBody, signature, metadata.allSpacesSecret)) {
    logger.warn('Rejected user delivery with bad signature', {
      component: 'webex/webhook',
      tenantId,
    });
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Malformed JSON body' }, { status: 400 });
  }
  const payload = parseWebhookPayload(body);
  if (!payload.ok) {
    return NextResponse.json({ error: 'Malformed webhook payload' }, { status: 400 });
  }
  if (payload.val.type !== 'messages.created') {
    // Only messages are registered; anything else is noise, acknowledged
    // so WebEx does not retry it.
    return NextResponse.json({ accepted: false });
  }

  const enqueued = await eventsQueue.producer.enqueue({
    tenantId,
    source: 'webex',
    type: 'user-message.created',
    payload: { ...payload.val.data, accountId },
    // One room's messages process in order per WATCHER — two opted-in
    // users in one space are separate, independently-ordered streams.
    orderingKey: payload.val.roomId ? `webex/${tenantId}/${accountId}/${payload.val.roomId}` : null,
  });
  if (!enqueued.ok) {
    logger.error('Event NOT accepted: {error}', {
      component: 'webex/webhook',
      tenantId,
      error: enqueued.err.message ?? 'unknown',
    });
    return NextResponse.json({ error: 'Could not accept event' }, { status: 500 });
  }

  return NextResponse.json({ accepted: true });
}
