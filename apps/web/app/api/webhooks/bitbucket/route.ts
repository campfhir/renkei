/**
 * Bitbucket webhook receipt — same shape as
 * webhooks/github/route.ts and webhooks/zoom/route.ts
 * (RENKEI.md Decision #17): verify, enqueue the raw delivery,
 * acknowledge. Matching and acting happens in the worker
 * (apps/worker/src/handlers/pr-pipeline-events.ts).
 *
 * Unlike a GitHub App, Bitbucket Cloud has no single account-level
 * webhook and does not sign deliveries by default — a webhook is
 * registered per repository, by hand, in that repository's own
 * settings (Repository settings → Webhooks), pointed at this URL and
 * carrying the value set on the Bitbucket connector
 * (admin/connectors/forms/atlassian-forms.tsx's showWebhookSecret field)
 * — preferably as an `X-Renkei-Webhook-Secret` header, or for webhooks
 * registered before the header existed, as a `?secret=` query parameter
 * (lib/bitbucket-webhook.ts). This is a real, documented gap next to
 * GitHub's zero-registration App webhook — call it out to whoever sets
 * a repository up for pipeline subscriptions.
 *
 * Only repo:commit_status_updated deliveries are useful to this
 * feature (a build/pipeline status changed on some commit) — every
 * other event a repository's webhook might be configured to send is
 * acknowledged and dropped without enqueueing.
 */

import { NextRequest, NextResponse } from 'next/server';
import { webhookEventsQueue } from '@renkei/queue';
import { loadKeyring } from '@renkei/crypto';
import { readConnectorConfigCached } from '@renkei/connector-config';
import { ATLASSIAN_BITBUCKET_CONNECTOR } from '@/lib/atlassian-app';
import { presentedBitbucketSecret, verifyBitbucketSecret } from '@/lib/bitbucket-webhook';
import { logger } from '@/lib/logger';
import {
  checkWebhookLimit,
  malformedSignature,
  payloadTooLarge,
  readWebhookBody,
  tooManyRequests,
} from '@/lib/webhook-intake';
import { isRecord } from '@renkei/guards';

const eventsQueue = webhookEventsQueue();

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Throttle, then the credential's presence, then a bounded body — all
  // before any config or database read (lib/webhook-intake.ts). Bitbucket's
  // credential is a shared secret, not an HMAC, so "shape" here is only
  // that one arrived and is not absurdly long.
  const verdict = checkWebhookLimit('bitbucket', request);
  if (!verdict.allowed) return tooManyRequests(verdict);
  const providedSecret = presentedBitbucketSecret(request.headers, request.nextUrl.searchParams);
  if (!providedSecret || providedSecret.length > 512) return malformedSignature();
  const eventKey = request.headers.get('x-event-key');

  const bodyResult = await readWebhookBody(request);
  if (!bodyResult.ok) return payloadTooLarge();
  const rawBody = bodyResult.val;

  const keyResult = loadKeyring('TOKEN_ENCRYPTION_KEY');
  if (!keyResult.ok) {
    logger.error(
      'A Bitbucket webhook delivery arrived, but TOKEN_ENCRYPTION_KEY is missing or malformed so the connector secret cannot be read; answered 500 and the delivery was not queued',
      {
        component: 'bitbucket/webhook',
      }
    );
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const configResult = await readConnectorConfigCached(
    ATLASSIAN_BITBUCKET_CONNECTOR,
    keyResult.val
  );
  if (!configResult.ok) {
    logger.error(
      'A Bitbucket webhook delivery arrived, but the Bitbucket connector configuration could not be read; answered 500 and the delivery was not queued: {error}',
      {
        component: 'bitbucket/webhook',
        error: configResult.err.message ?? configResult.err.type,
      }
    );
    return NextResponse.json({ error: 'Connector configuration unavailable' }, { status: 500 });
  }
  const config = configResult.val;
  const webhookSecret = config?.secrets.webhookSecret;
  if (!config || !config.enabled || typeof webhookSecret !== 'string' || !webhookSecret) {
    logger.warn(
      'A Bitbucket {type} delivery arrived, but the Bitbucket connector is off or has no webhook secret; answered 503 and the delivery was dropped',
      {
        component: 'bitbucket/webhook',
        type: eventKey ?? 'unknown',
      }
    );
    return NextResponse.json(
      { error: 'Bitbucket connector not configured for webhooks' },
      { status: 503 }
    );
  }

  if (!verifyBitbucketSecret(providedSecret, webhookSecret)) {
    logger.warn(
      "A Bitbucket {type} delivery was rejected (401) because the secret it presented is not the connector's webhook secret; dropped",
      {
        component: 'bitbucket/webhook',
        type: eventKey ?? 'unknown',
      }
    );
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
    source: 'atlassian-bitbucket',
    type: 'repo:commit_status_updated',
    payload: body,
    orderingKey: repoFullName ? `bitbucket/${repoFullName}` : null,
  });
  if (!enqueued.ok) {
    logger.error(
      'Bitbucket sent a verified {type} event for {repository}, but it was not queued for the worker; answered 500 so Bitbucket retries: {error}',
      {
        component: 'bitbucket/webhook',
        type: eventKey,
        repository: repoFullName ?? '(unknown repository)',
        error: enqueued.err.message ?? 'unknown',
      }
    );
    return NextResponse.json({ error: 'Could not accept event' }, { status: 500 });
  }

  logger.debug(
    'Bitbucket sent a verified {type} event for {repository}; it was queued for the worker',
    {
      component: 'bitbucket/webhook',
      type: eventKey,
      repository: repoFullName ?? '(unknown repository)',
    }
  );
  return NextResponse.json({ accepted: true });
}
