/**
 * Zoom webhook receipt — deliberately thin (RENKEI.md Decision #17):
 * verify, INSERT an event row, acknowledge. All processing — resolving the
 * host's grant, downloading the transcript, embedding — happens in the
 * worker.
 *
 * Zoom's protocol has two extras over the WebEx shape this copies:
 * - Every delivery is signed: x-zm-signature = 'v0=' + HMAC-SHA256 of
 *   'v0:{timestamp}:{rawBody}' under the app's Secret Token, and the
 *   timestamp must be fresh (replay window).
 * - Saving the endpoint URL in the Marketplace app fires an
 *   endpoint.url_validation event that must be answered with an HMAC
 *   challenge response — handled inline, never enqueued.
 *
 * The Secret Token is per-tenant connector configuration from the database
 * (connector_configs), not an environment variable.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { webhookEventsQueue } from '@renkei/queue';
import { parseEncryptionKey } from '@renkei/crypto';
import { readConnectorConfigCached } from '@renkei/connector-config';
import {
  verifyZoomSignature,
  buildUrlValidationResponse,
  urlValidationTokenOf,
  parseZoomWebhookPayload,
  ZOOM_CONNECTOR,
} from '@renkei/connector-zoom';
import { logger } from '@/lib/logger';

const eventsQueue = webhookEventsQueue();

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;

  // The signature covers the raw bytes; parse only after it verifies.
  const rawBody = await request.text();
  const signature = request.headers.get('x-zm-signature');
  const timestamp = request.headers.get('x-zm-request-timestamp');

  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) {
    logger.error('TOKEN_ENCRYPTION_KEY is missing or malformed', {
      component: 'zoom/webhook',
      tenantId,
    });
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    // 500 so Zoom retries the delivery instead of dropping it.
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

  const configResult = await readConnectorConfigCached(tenantId, ZOOM_CONNECTOR, keyResult.val);
  if (!configResult.ok) {
    return NextResponse.json({ error: 'Connector configuration unavailable' }, { status: 500 });
  }
  const config = configResult.val;
  const secretToken = config?.secrets.secretToken;
  if (!config || !config.enabled || typeof secretToken !== 'string' || !secretToken) {
    logger.warn('Delivery for a tenant without an enabled zoom connector (or no Secret Token)', {
      component: 'zoom/webhook',
      tenantId,
    });
    return NextResponse.json({ error: 'Zoom connector not configured' }, { status: 503 });
  }

  // Signature + freshness on EVERY delivery, url_validation included — the
  // challenge proves possession of the Secret Token in both directions.
  if (!verifyZoomSignature(rawBody, signature, timestamp, secretToken)) {
    logger.warn('Rejected delivery with bad signature or stale timestamp', {
      component: 'zoom/webhook',
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

  // Marketplace endpoint validation: answer the challenge, enqueue nothing.
  const plainToken = urlValidationTokenOf(body);
  if (plainToken !== null) {
    return NextResponse.json(buildUrlValidationResponse(plainToken, secretToken));
  }

  const payload = parseZoomWebhookPayload(body);
  if (!payload.ok) {
    return NextResponse.json({ error: 'Malformed webhook payload' }, { status: 400 });
  }

  // The full delivery body is the event payload: the worker re-parses it
  // and re-fetches everything of substance from the API under the host's
  // grant — webhook contents are routing hints, not trusted data.
  const enqueued = await eventsQueue.producer.enqueue({
    tenantId,
    source: ZOOM_CONNECTOR,
    type: payload.val.type,
    payload: isRecord(body) ? body : {},
    // One meeting's transcript/summary events process in order.
    orderingKey: payload.val.meetingUuid ? `zoom/${tenantId}/${payload.val.meetingUuid}` : null,
  });
  if (!enqueued.ok) {
    logger.error('Event NOT accepted: {error}', {
      component: 'zoom/webhook',
      tenantId,
      error: enqueued.err.message ?? 'unknown',
    });
    return NextResponse.json({ error: 'Could not accept event' }, { status: 500 });
  }

  logger.info('Event accepted', { component: 'zoom/webhook', tenantId, type: payload.val.type });
  return NextResponse.json({ accepted: true });
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
