/**
 * GitHub webhook receipt — deliberately thin, the same shape as
 * webhooks/zoom/[tenantId]/route.ts (RENKEI.md Decision #17): verify,
 * enqueue the raw delivery, acknowledge. All matching and acting —
 * finding which pr_subscriptions this delivery is about, re-fetching
 * the authoritative run state, merging or noting a fix — happens in the
 * worker (apps/worker/src/handlers/pr-pipeline-events.ts).
 *
 * A GitHub App has exactly one webhook URL, configured on the App's own
 * registration (github.com/settings/apps/<slug> → Webhook), covering
 * every repository it's installed on for every tenant that installed
 * it — so unlike Bitbucket there is no per-repository registration step
 * here, only the one App-level URL an operator sets once (this route)
 * and the Webhook secret they set to match the GitHub connector's own
 * (admin/connectors/forms/github-form.tsx).
 *
 * Only `workflow_run` deliveries are useful to this feature (a
 * completed Actions run, possibly attached to a pull request) — every
 * other event type this shared App-level webhook necessarily also
 * receives is acknowledged and dropped without enqueueing.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { webhookEventsQueue } from '@renkei/queue';
import { parseEncryptionKey } from '@renkei/crypto';
import { readConnectorConfigCached } from '@renkei/connector-config';
import { GITHUB_CONNECTOR } from '@/lib/github-app';
import { verifyGitHubSignature } from '@/lib/github-webhook';
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

  // The signature covers the raw bytes; parse only after it verifies.
  const rawBody = await request.text();
  const signature = request.headers.get('x-hub-signature-256');
  const eventType = request.headers.get('x-github-event');

  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) {
    logger.error('TOKEN_ENCRYPTION_KEY is missing or malformed', {
      component: 'github/webhook',
      tenantId,
    });
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    // 500 so GitHub retries the delivery instead of dropping it.
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

  const configResult = await readConnectorConfigCached(tenantId, GITHUB_CONNECTOR, keyResult.val);
  if (!configResult.ok) {
    return NextResponse.json({ error: 'Connector configuration unavailable' }, { status: 500 });
  }
  const config = configResult.val;
  const webhookSecret = config?.secrets.webhookSecret;
  if (!config || !config.enabled || typeof webhookSecret !== 'string' || !webhookSecret) {
    logger.warn('Delivery for a tenant with no GitHub webhook secret configured', {
      component: 'github/webhook',
      tenantId,
    });
    return NextResponse.json({ error: 'GitHub connector not configured for webhooks' }, { status: 503 });
  }

  if (!verifyGitHubSignature(rawBody, signature, webhookSecret)) {
    logger.warn('Rejected delivery with bad signature', { component: 'github/webhook', tenantId });
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
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

  // Only workflow_run deliveries feed the pipeline-subscription feature;
  // every other event type this App-level webhook also receives is
  // acknowledged without being queued.
  if (eventType !== 'workflow_run') {
    return NextResponse.json({ accepted: true, ignored: eventType ?? 'unknown' });
  }

  const repository = isRecord(body.repository) ? body.repository : {};
  const repoFullName = typeof repository.full_name === 'string' ? repository.full_name : null;

  // The full delivery body is the event payload: the worker re-parses it
  // and re-fetches everything of substance from the API under the
  // subscriber's own grant — webhook contents are routing hints, not
  // trusted data.
  const enqueued = await eventsQueue.producer.enqueue({
    tenantId,
    source: 'github',
    type: 'workflow_run',
    payload: body,
    orderingKey: repoFullName ? `github/${tenantId}/${repoFullName}` : null,
  });
  if (!enqueued.ok) {
    logger.error('Event NOT accepted: {error}', {
      component: 'github/webhook',
      tenantId,
      error: enqueued.err.message ?? 'unknown',
    });
    return NextResponse.json({ error: 'Could not accept event' }, { status: 500 });
  }

  logger.debug('Event accepted', { component: 'github/webhook', tenantId, type: eventType });
  return NextResponse.json({ accepted: true });
}
