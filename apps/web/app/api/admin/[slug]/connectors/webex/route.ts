/**
 * Org-admin configuration of the WebEx connector (RENKEI.md Decision #13:
 * connectors are provisioned by org-admins, and their credentials are policy
 * data in the database, not deployment environment).
 *
 * GET reports whether the connector is configured and enabled — never the
 * secret values. PUT stores the bot token and webhook secret sealed with the
 * deployment key, and invalidates the read cache so the change takes effect
 * immediately rather than after the TTL.
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { getDatabase } from '@renkei/db';
import { parseEncryptionKey } from '@renkei/crypto';
import {
  getConnectorConfig,
  setConnectorConfig,
  invalidateConnectorConfigCache,
} from '@renkei/connector-config';
import { WEBEX_CONNECTOR } from '@renkei/connector-webex';

async function tenantIdForSlug(slug: string): Promise<string | null> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return null;
  const tenant = await dbResult.val
    .selectFrom('tenants')
    .select('id')
    .where('slug', '=', slug)
    .executeTakeFirst();
  return tenant?.id ?? null;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
): Promise<NextResponse> {
  const { slug } = await params;
  const tenantId = await tenantIdForSlug(slug);
  if (!tenantId) {
    return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  }
  const access = await checkAccess(tenantId, [ROLE_OPERATOR]);
  if (!access) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const configResult = await getConnectorConfig(tenantId, WEBEX_CONNECTOR, keyResult.val);
  if (!configResult.ok) {
    return NextResponse.json({ error: 'Could not read connector config' }, { status: 500 });
  }

  const config = configResult.val;
  return NextResponse.json({
    connector: WEBEX_CONNECTOR,
    configured: config !== null,
    enabled: config?.enabled ?? false,
    // Presence only — secret values never leave the server.
    hasBotToken: Boolean(config?.secrets.botToken),
    hasWebhookSecret: Boolean(config?.secrets.webhookSecret),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
): Promise<NextResponse> {
  const { slug } = await params;
  const tenantId = await tenantIdForSlug(slug);
  if (!tenantId) {
    return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  }
  const access = await checkAccess(tenantId, [ROLE_OPERATOR]);
  if (!access) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body: unknown = await request.json().catch(() => null);
  if (!isRecord(body)) {
    return NextResponse.json({ error: 'JSON body required' }, { status: 400 });
  }
  const { botToken, webhookSecret } = body;
  if (typeof botToken !== 'string' || botToken.length === 0) {
    return NextResponse.json({ error: 'botToken is required' }, { status: 400 });
  }
  if (typeof webhookSecret !== 'string' || webhookSecret.length === 0) {
    return NextResponse.json({ error: 'webhookSecret is required' }, { status: 400 });
  }
  const enabled = typeof body.enabled === 'boolean' ? body.enabled : true;

  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const writeResult = await setConnectorConfig(
    tenantId,
    WEBEX_CONNECTOR,
    { enabled, settings: {}, secrets: { botToken, webhookSecret } },
    keyResult.val
  );
  if (!writeResult.ok) {
    return NextResponse.json({ error: 'Could not store connector config' }, { status: 500 });
  }

  invalidateConnectorConfigCache(tenantId, WEBEX_CONNECTOR);
  return NextResponse.json({ connector: WEBEX_CONNECTOR, configured: true, enabled });
}
