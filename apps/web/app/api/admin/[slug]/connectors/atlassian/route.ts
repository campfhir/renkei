/**
 * Org-admin configuration of the Atlassian OAuth app (RENKEI.md Decision
 * #13): client id, scopes, and optional redirect override live in connector
 * settings; the client secret is sealed with the deployment key. GET reports
 * presence only — secret values never leave the server.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getOperatorAccess } from '@/lib/operator-access';
import { getDatabase } from '@renkei/db';
import { parseEncryptionKey } from '@renkei/crypto';
import {
  getConnectorConfig,
  setConnectorConfig,
  invalidateConnectorConfigCache,
} from '@renkei/connector-config';
import { ATLASSIAN_CONNECTOR, DEFAULT_ATLASSIAN_SCOPES } from '@/lib/atlassian-app';

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
  const access = await getOperatorAccess(tenantId);
  if (!access) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const configResult = await getConnectorConfig(tenantId, ATLASSIAN_CONNECTOR, keyResult.val);
  if (!configResult.ok) {
    return NextResponse.json({ error: 'Could not read connector config' }, { status: 500 });
  }

  const config = configResult.val;
  return NextResponse.json({
    connector: ATLASSIAN_CONNECTOR,
    configured: config !== null,
    enabled: config?.enabled ?? false,
    clientId: typeof config?.settings.clientId === 'string' ? config.settings.clientId : null,
    scopes: typeof config?.settings.scopes === 'string' ? config.settings.scopes : null,
    redirectUri:
      typeof config?.settings.redirectUri === 'string' ? config.settings.redirectUri : null,
    hasClientSecret: Boolean(config?.secrets.clientSecret),
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
  const access = await getOperatorAccess(tenantId);
  if (!access) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body: unknown = await request.json().catch(() => null);
  if (!isRecord(body)) {
    return NextResponse.json({ error: 'JSON body required' }, { status: 400 });
  }
  const { clientId, clientSecret } = body;
  if (typeof clientId !== 'string' || clientId.length === 0) {
    return NextResponse.json({ error: 'clientId is required' }, { status: 400 });
  }
  if (typeof clientSecret !== 'string' || clientSecret.length === 0) {
    return NextResponse.json({ error: 'clientSecret is required' }, { status: 400 });
  }
  const enabled = typeof body.enabled === 'boolean' ? body.enabled : true;
  const scopes =
    typeof body.scopes === 'string' && body.scopes ? body.scopes : DEFAULT_ATLASSIAN_SCOPES;
  const redirectUri =
    typeof body.redirectUri === 'string' && body.redirectUri ? body.redirectUri : undefined;

  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const settings: Record<string, unknown> = { clientId, scopes };
  if (redirectUri) settings.redirectUri = redirectUri;

  const writeResult = await setConnectorConfig(
    tenantId,
    ATLASSIAN_CONNECTOR,
    { enabled, settings, secrets: { clientSecret } },
    keyResult.val
  );
  if (!writeResult.ok) {
    return NextResponse.json({ error: 'Could not store connector config' }, { status: 500 });
  }

  invalidateConnectorConfigCache(tenantId, ATLASSIAN_CONNECTOR);
  return NextResponse.json({ connector: ATLASSIAN_CONNECTOR, configured: true, enabled });
}
