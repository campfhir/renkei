/**
 * Org-admin configuration of the Zoom app (a user-managed General app from
 * the Zoom Marketplace). GET reports presence only — secret values never
 * leave the server. The scopes saved here document the Marketplace app's
 * scope set and act as the org ceiling users narrow within; the Secret
 * Token (Features → Access in the Marketplace app) is what verifies
 * webhook deliveries and answers the url_validation challenge.
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { parseEncryptionKey } from '@renkei/crypto';
import {
  getConnectorConfig,
  setConnectorConfig,
  invalidateConnectorConfigCache,
} from '@renkei/connector-config';
import { ZOOM_CONNECTOR, DEFAULT_ZOOM_SCOPES } from '@/lib/zoom-app';

export async function GET(
  _request: NextRequest,
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

  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const configResult = await getConnectorConfig(tenantRef.id, ZOOM_CONNECTOR, keyResult.val);
  if (!configResult.ok) {
    return NextResponse.json({ error: 'Could not read connector config' }, { status: 500 });
  }

  const config = configResult.val;
  return NextResponse.json({
    connector: ZOOM_CONNECTOR,
    configured: config !== null,
    enabled: config?.enabled ?? false,
    clientId: typeof config?.settings.clientId === 'string' ? config.settings.clientId : null,
    scopes: typeof config?.settings.scopes === 'string' ? config.settings.scopes : null,
    hasClientSecret: Boolean(config?.secrets.clientSecret),
    hasSecretToken: Boolean(config?.secrets.secretToken),
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
  const tenantRef = await tenantForSlug(slug);
  if (!tenantRef) {
    return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  }
  const access = await checkAccess(tenantRef.id, [ROLE_OPERATOR]);
  if (!access) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body: unknown = await request.json().catch(() => null);
  if (!isRecord(body)) {
    return NextResponse.json({ error: 'JSON body required' }, { status: 400 });
  }
  const { clientId, clientSecret, secretToken } = body;
  if (typeof clientId !== 'string' || clientId.length === 0) {
    return NextResponse.json({ error: 'clientId is required' }, { status: 400 });
  }
  // Optional: OAuth works without it, but webhook ingestion refuses
  // everything until it is set, so its absence is reported, not hidden.
  if (secretToken !== undefined && typeof secretToken !== 'string') {
    return NextResponse.json({ error: 'secretToken must be a string' }, { status: 400 });
  }
  const enabled = typeof body.enabled === 'boolean' ? body.enabled : true;
  const scopes = typeof body.scopes === 'string' && body.scopes ? body.scopes : DEFAULT_ZOOM_SCOPES;

  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  // Secrets survive settings-only saves: setConnectorConfig replaces secrets
  // wholesale, so a blank/omitted secret is merged with the stored one here.
  // clientSecret is required only when none is stored yet; secretToken stays
  // optional overall, but blank means keep the stored token, not clear it.
  const existing = await getConnectorConfig(tenantRef.id, ZOOM_CONNECTOR, keyResult.val);
  const storedSecrets = existing.ok && existing.val ? existing.val.secrets : {};
  const mergedClientSecret =
    typeof clientSecret === 'string' && clientSecret.length > 0
      ? clientSecret
      : storedSecrets.clientSecret;
  if (!mergedClientSecret) {
    return NextResponse.json(
      { error: 'clientSecret is required (none stored yet)' },
      { status: 400 }
    );
  }
  const mergedSecretToken =
    typeof secretToken === 'string' && secretToken.length > 0
      ? secretToken
      : storedSecrets.secretToken;

  const secrets: Record<string, string> = { clientSecret: mergedClientSecret };
  if (mergedSecretToken) {
    secrets.secretToken = mergedSecretToken;
  }

  const writeResult = await setConnectorConfig(
    tenantRef.id,
    ZOOM_CONNECTOR,
    { enabled, settings: { clientId, scopes }, secrets },
    keyResult.val
  );
  if (!writeResult.ok) {
    return NextResponse.json({ error: 'Could not store connector config' }, { status: 500 });
  }

  invalidateConnectorConfigCache(tenantRef.id, ZOOM_CONNECTOR);
  return NextResponse.json({
    connector: ZOOM_CONNECTOR,
    configured: true,
    enabled,
    hasSecretToken: Boolean(secrets.secretToken),
  });
}
