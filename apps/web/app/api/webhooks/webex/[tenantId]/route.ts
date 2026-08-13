/**
 * WebEx webhook receipt — deliberately thin (RENKEI.md Decision #17).
 *
 * This route does exactly three things: verify the delivery signature over
 * the raw body, validate the payload's shape, and produce onto the webhook
 * events queue (@renkei/queue). All processing — fetching the message,
 * classification, producing an actionable item — happens in the worker,
 * which consumes that queue. WebEx
 * retries slow webhook endpoints aggressively; acknowledging fast and
 * processing asynchronously is the correct shape as well as ours.
 *
 * The webhook secret is per-tenant connector configuration from the
 * database (connector_configs), not an environment variable — connectors
 * are provisioned by org-admins at runtime. Only the deployment encryption
 * key comes from the environment.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { webhookEventsQueue } from '@renkei/queue';
import { parseEncryptionKey } from '@renkei/crypto';
import { readConnectorConfigCached } from '@renkei/connector-config';
import {
  verifyWebexSignature,
  parseWebhookPayload,
  WEBEX_CONNECTOR,
} from '@renkei/connector-webex';
import { logger } from '@/lib/logger';

const eventsQueue = webhookEventsQueue();

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;

  // The signature covers the raw bytes; parse only after it verifies.
  const rawBody = await request.text();
  const signature = request.headers.get('x-spark-signature') ?? '';

  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) {
    logger.error('TOKEN_ENCRYPTION_KEY is missing or malformed', {
      component: 'webex/webhook',
      tenantId,
    });
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    // 500 so WebEx retries the delivery instead of dropping it.
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }
  const db = dbResult.val;

  const tenant = await db
    .selectFrom('tenants')
    .select('id')
    .where('id', '=', tenantId)
    .executeTakeFirst();
  if (!tenant) {
    return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  }

  const configResult = await readConnectorConfigCached(tenantId, WEBEX_CONNECTOR, keyResult.val);
  if (!configResult.ok) {
    return NextResponse.json({ error: 'Connector configuration unavailable' }, { status: 500 });
  }
  const config = configResult.val;
  const webhookSecret = config?.secrets.webhookSecret;
  if (!config || !config.enabled || !webhookSecret) {
    logger.warn('Delivery for a tenant without an enabled webex connector', {
      component: 'webex/webhook',
      tenantId,
    });
    return NextResponse.json({ error: 'WebEx connector not configured' }, { status: 503 });
  }

  if (!verifyWebexSignature(rawBody, signature, webhookSecret)) {
    logger.warn('Rejected delivery with bad signature', { component: 'webex/webhook', tenantId });
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

  const enqueued = await eventsQueue.producer.enqueue({
    tenantId,
    source: WEBEX_CONNECTOR,
    type: payload.val.type,
    payload: payload.val.data,
    // One room's messages process in order even with several interactive
    // workers; different rooms parallelize.
    orderingKey: payload.val.roomId ? `webex/${tenantId}/${payload.val.roomId}` : null,
  });
  if (!enqueued.ok) {
    logger.error('Event NOT accepted: {error}', {
      component: 'webex/webhook',
      tenantId,
      error: enqueued.err.message ?? 'unknown',
    });
    return NextResponse.json({ error: 'Could not accept event' }, { status: 500 });
  }

  logger.info('Event accepted', { component: 'webex/webhook', tenantId, type: payload.val.type });
  return NextResponse.json({ accepted: true });
}
