/**
 * GitHub webhook receipt — deliberately thin, the same shape as
 * webhooks/zoom/route.ts (RENKEI.md Decision #17): verify,
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
import { webhookEventsQueue } from '@renkei/queue';
import { loadKeyring } from '@renkei/crypto';
import { readConnectorConfigCached } from '@renkei/connector-config';
import { GITHUB_CONNECTOR } from '@/lib/github-app';
import { verifyGitHubSignature } from '@/lib/github-webhook';
import { logger } from '@/lib/logger';
import {
  GITHUB_SIGNATURE_SHAPE,
  checkWebhookLimit,
  hasSignatureShape,
  malformedSignature,
  payloadTooLarge,
  readWebhookBody,
  tooManyRequests,
} from '@/lib/webhook-intake';
import { isRecord } from '@renkei/guards';

const eventsQueue = webhookEventsQueue();

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Throttle, then the credential's shape, then a bounded body — all before
  // any config or database read (lib/webhook-intake.ts).
  const verdict = checkWebhookLimit('github', request);
  if (!verdict.allowed) return tooManyRequests(verdict);
  const signature = request.headers.get('x-hub-signature-256');
  if (!hasSignatureShape(signature, GITHUB_SIGNATURE_SHAPE)) return malformedSignature();
  const eventType = request.headers.get('x-github-event');

  // The signature covers the raw bytes; parse only after it verifies.
  const bodyResult = await readWebhookBody(request);
  if (!bodyResult.ok) return payloadTooLarge();
  const rawBody = bodyResult.val;

  const keyResult = loadKeyring('TOKEN_ENCRYPTION_KEY');
  if (!keyResult.ok) {
    logger.error(
      'A GitHub webhook delivery arrived, but TOKEN_ENCRYPTION_KEY is missing or malformed so the connector secret cannot be read; answered 500 and the delivery was not queued',
      {
        component: 'github/webhook',
      }
    );
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const configResult = await readConnectorConfigCached(GITHUB_CONNECTOR, keyResult.val);
  if (!configResult.ok) {
    logger.error(
      'A GitHub webhook delivery arrived, but the GitHub connector configuration could not be read; answered 500 and the delivery was not queued: {error}',
      {
        component: 'github/webhook',
        error: configResult.err.message ?? configResult.err.type,
      }
    );
    return NextResponse.json({ error: 'Connector configuration unavailable' }, { status: 500 });
  }
  const config = configResult.val;
  const webhookSecret = config?.secrets.webhookSecret;
  if (!config || !config.enabled || typeof webhookSecret !== 'string' || !webhookSecret) {
    logger.warn(
      'A GitHub {type} delivery arrived, but the GitHub connector is off or has no webhook secret; answered 503 and the delivery was dropped',
      {
        component: 'github/webhook',
        type: eventType ?? 'unknown',
      }
    );
    return NextResponse.json(
      { error: 'GitHub connector not configured for webhooks' },
      { status: 503 }
    );
  }

  if (!verifyGitHubSignature(rawBody, signature, webhookSecret)) {
    logger.warn(
      "A GitHub {type} delivery was rejected (401) because its signature did not verify against the connector's webhook secret; dropped",
      { component: 'github/webhook', type: eventType ?? 'unknown' }
    );
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
    source: 'github',
    type: 'workflow_run',
    payload: body,
    orderingKey: repoFullName ? `github/${repoFullName}` : null,
  });
  if (!enqueued.ok) {
    logger.error(
      'GitHub sent a verified {type} event for {repository}, but it was not queued for the worker; answered 500 so GitHub retries: {error}',
      {
        component: 'github/webhook',
        type: eventType,
        repository: repoFullName ?? '(unknown repository)',
        error: enqueued.err.message ?? 'unknown',
      }
    );
    return NextResponse.json({ error: 'Could not accept event' }, { status: 500 });
  }

  logger.debug(
    'GitHub sent a verified {type} event for {repository}; it was queued for the worker',
    {
      component: 'github/webhook',
      type: eventType,
      repository: repoFullName ?? '(unknown repository)',
    }
  );
  return NextResponse.json({ accepted: true });
}
