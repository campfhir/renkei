/**
 * Bitbucket webhook receipt — same shape as
 * webhooks/github/[tenantId]/route.ts and webhooks/zoom/[tenantId]/route.ts
 * (RENKEI.md Decision #17): verify, enqueue the raw delivery,
 * acknowledge. Matching and acting happens in the worker
 * (apps/worker/src/handlers/pr-pipeline-events.ts).
 *
 * Unlike a GitHub App, Bitbucket Cloud has no single account-level
 * webhook and does not sign deliveries by default — a webhook is
 * registered per repository, by hand, in that repository's own
 * settings (Repository settings → Webhooks), pointed at this URL with
 * a `?secret=` query parameter matching the value set on the Bitbucket
 * connector (admin/connectors/forms/atlassian-forms.tsx's
 * showWebhookSecret field). This is a real, documented gap next to
 * GitHub's zero-registration App webhook — call it out to whoever sets
 * a repository up for pipeline subscriptions.
 *
 * Only repo:commit_status_updated deliveries are useful to this
 * feature (a build/pipeline status changed on some commit) — every
 * other event a repository's webhook might be configured to send is
 * acknowledged and dropped without enqueueing.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { webhookEventsQueue } from '@renkei/queue';
import { parseEncryptionKey } from '@renkei/crypto';
import { readConnectorConfigCached } from '@renkei/connector-config';
import { ATLASSIAN_BITBUCKET_CONNECTOR } from '@/lib/atlassian-app';
import { verifyBitbucketSecret } from '@/lib/bitbucket-webhook';
import { logger } from '@/lib/logger';

const eventsQueue = webhookEventsQueue();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;

  const rawBody = await request.text();
  const providedSecret = request.nextUrl.searchParams.get('secret');
  const eventKey = request.headers.get('x-event-key');

  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) {
    logger.error('TOKEN_ENCRYPTION_KEY is missing or malformed', {
      component: 'bitbucket/webhook',
      tenantId,
    });
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) {
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

  const configResult = await readConnectorConfigCached(
    tenantId,
    ATLASSIAN_BITBUCKET_CONNECTOR,
    keyResult.val
  );
  if (!configResult.ok) {
    return NextResponse.json({ error: 'Connector configuration unavailable' }, { status: 500 });
  }
  const config = configResult.val;
  const webhookSecret = config?.secrets.webhookSecret;
  if (!config || !config.enabled || typeof webhookSecret !== 'string' || !webhookSecret) {
    logger.warn('Delivery for a tenant with no Bitbucket webhook secret configured', {
      component: 'bitbucket/webhook',
      tenantId,
    });
    return NextResponse.json(
      { error: 'Bitbucket connector not configured for webhooks' },
      { status: 503 }
    );
  }

  if (!verifyBitbucketSecret(providedSecret, webhookSecret)) {
    logger.warn('Rejected delivery with a missing or wrong secret', {
      component: 'bitbucket/webhook',
      tenantId,
    });
    return NextResponse.json({ error: 'Invalid secret' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Malformed JSON body' }, { status: 400 });
  }
  if (!isRecord(body)) {
    return NextResponse.json({ error: 'Malformed webhook payload' }, { status: 400 });
  }

  if (eventKey !== 'repo:commit_status_updated') {
    return NextResponse.json({ accepted: true, ignored: eventKey ?? 'unknown' });
  }

  const repository = isRecord(body.repository) ? body.repository : {};
  const repoFullName = typeof repository.full_name === 'string' ? repository.full_name : null;

  const enqueued = await eventsQueue.producer.enqueue({
    tenantId,
    source: 'atlassian-bitbucket',
    type: 'repo:commit_status_updated',
    payload: body,
    orderingKey: repoFullName ? `bitbucket/${tenantId}/${repoFullName}` : null,
  });
  if (!enqueued.ok) {
    logger.error('Event NOT accepted: {error}', {
      component: 'bitbucket/webhook',
      tenantId,
      error: enqueued.err.message ?? 'unknown',
    });
    return NextResponse.json({ error: 'Could not accept event' }, { status: 500 });
  }

  logger.debug('Event accepted', { component: 'bitbucket/webhook', tenantId, type: eventKey });
  return NextResponse.json({ accepted: true });
}
