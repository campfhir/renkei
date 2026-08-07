/**
 * WebEx webhook receipt — deliberately thin (RENKEI.md Decision #17).
 *
 * This route does exactly three things: verify the delivery signature over
 * the raw body, validate the payload's shape, and INSERT an event row. All
 * processing — fetching the message, classification, producing an actionable
 * item — happens in the worker, which consumes the events table. WebEx
 * retries slow webhook endpoints aggressively; acknowledging fast and
 * processing asynchronously is the correct shape as well as ours.
 */

import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { getDatabase } from '@renkei/db';
import { verifyWebexSignature, parseWebhookPayload } from '@renkei/connector-webex';
import { logger } from '@/lib/logger';

const WEBEX_SOURCE = 'webex';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;

  // Read straight from env rather than the full config module: the webhook
  // must answer even when unrelated configuration is broken, and the secret
  // is the only setting it needs.
  const secret = process.env.WEBEX_WEBHOOK_SECRET;
  if (!secret) {
    logger.warn('[Webex webhook] Delivery received but WEBEX_WEBHOOK_SECRET is not configured', {
      tenantId,
    });
    return NextResponse.json({ error: 'WebEx connector not configured' }, { status: 503 });
  }

  // The signature covers the raw bytes; parse only after it verifies.
  const rawBody = await request.text();
  const signature = request.headers.get('x-spark-signature') ?? '';
  if (!verifyWebexSignature(rawBody, signature, secret)) {
    logger.warn('[Webex webhook] Rejected delivery with bad signature', { tenantId });
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

  await db
    .insertInto('events')
    .values({
      id: randomUUID(),
      tenant_id: tenantId,
      source: WEBEX_SOURCE,
      type: payload.val.type,
      payload: JSON.stringify(payload.val.data),
    })
    .execute();

  logger.info('[Webex webhook] Event accepted', { tenantId, type: payload.val.type });
  return NextResponse.json({ accepted: true });
}
