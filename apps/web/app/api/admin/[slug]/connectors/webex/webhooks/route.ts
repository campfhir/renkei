/**
 * WebEx webhook self-management: Renkei holds the bot token, so registering
 * webhooks is Renkei's job, not an operator's curl session.
 *
 * GET reports webhook health against the two required registrations —
 * read-only, secrets never leave the server. POST reconciles: creates
 * what's missing, recreates what's inactive or signing with a stale secret,
 * deletes duplicates. Both need the connector configured (bot token +
 * webhook secret) and a resolvable public origin to point WebEx at.
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getDatabase } from '@renkei/db';
import { parseEncryptionKey } from '@renkei/crypto';
import { getConnectorConfig } from '@renkei/connector-config';
import {
  WEBEX_CONNECTOR,
  WebexClient,
  webexWebhookTargetUrl,
  inspectWebexWebhooks,
  ensureWebexWebhooks,
} from '@renkei/connector-webex';
import { getOrigin } from '@/lib/get-origin';

interface WebhookContext {
  client: WebexClient;
  targetUrl: string;
  secret: string;
}

type ContextFailure = { status: number; error: string };

async function resolveWebhookContext(
  request: NextRequest,
  slug: string
): Promise<{ ok: true; val: WebhookContext } | { ok: false; err: ContextFailure }> {
  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return { ok: false, err: { status: 500, error: 'Database unavailable' } };
  }
  const tenant = await dbResult.val
    .selectFrom('tenants')
    .select('id')
    .where('slug', '=', slug)
    .executeTakeFirst();
  if (!tenant) {
    return { ok: false, err: { status: 404, error: 'Tenant not found' } };
  }

  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) {
    return { ok: false, err: { status: 500, error: 'Server misconfigured' } };
  }

  const configResult = await getConnectorConfig(tenant.id, WEBEX_CONNECTOR, keyResult.val);
  if (!configResult.ok) {
    return { ok: false, err: { status: 500, error: 'Could not read connector config' } };
  }
  const config = configResult.val;
  const botToken = config?.secrets.botToken;
  const secret = config?.secrets.webhookSecret;
  if (!config || !config.enabled || !botToken || !secret) {
    return {
      ok: false,
      err: {
        status: 409,
        error: 'WebEx connector is not configured — store the bot token and webhook secret first',
      },
    };
  }

  const origin = await getOrigin(request);
  if (!origin.ok) {
    return { ok: false, err: { status: 500, error: 'Could not resolve public origin' } };
  }

  return {
    ok: true,
    val: {
      client: new WebexClient(botToken),
      targetUrl: webexWebhookTargetUrl(origin.val, tenant.id),
      secret,
    },
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
): Promise<NextResponse> {
  const { slug } = await params;
  const tenantRef = await tenantForSlug(slug);
  if (!tenantRef) {
    return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  }
  const access = await checkAccess(tenantRef.id, [ROLE_OPERATOR]);
  if (!access) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const context = await resolveWebhookContext(request, slug);
  if (!context.ok) {
    return NextResponse.json({ error: context.err.error }, { status: context.err.status });
  }

  const inspection = await inspectWebexWebhooks(
    context.val.client,
    context.val.targetUrl,
    context.val.secret
  );
  if (!inspection.ok) {
    return NextResponse.json({ error: 'WebEx API unreachable' }, { status: 502 });
  }

  return NextResponse.json({
    connector: WEBEX_CONNECTOR,
    targetUrl: context.val.targetUrl,
    healthy: inspection.val.healthy,
    registrations: inspection.val.registrations,
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
): Promise<NextResponse> {
  const { slug } = await params;
  const tenantRef = await tenantForSlug(slug);
  if (!tenantRef) {
    return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  }
  const access = await checkAccess(tenantRef.id, [ROLE_OPERATOR]);
  if (!access) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const context = await resolveWebhookContext(request, slug);
  if (!context.ok) {
    return NextResponse.json({ error: context.err.error }, { status: context.err.status });
  }

  const reconciled = await ensureWebexWebhooks(context.val.client, {
    targetUrl: context.val.targetUrl,
    secret: context.val.secret,
  });
  if (!reconciled.ok) {
    return NextResponse.json({ error: 'WebEx API unreachable' }, { status: 502 });
  }

  return NextResponse.json({
    connector: WEBEX_CONNECTOR,
    targetUrl: context.val.targetUrl,
    changed: reconciled.val.changed,
    registrations: reconciled.val.registrations,
  });
}
