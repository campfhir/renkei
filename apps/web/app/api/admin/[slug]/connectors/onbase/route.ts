/**
 * Org-admin configuration of the OnBase connector. Unlike the SaaS
 * connectors there is no vendor console: the customer runs their own
 * OnBase API Server and Hyland IdP, so this row holds the API server base
 * URL, the IdP issuer, the client registered for Renkei on that IdP, and
 * the IdP scope name the API Server is configured to require. GET reports
 * presence only — the client secret never leaves the server — and a public
 * PKCE client (no secret at all) is a valid configuration.
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
import { ONBASE_CONNECTOR } from '@/lib/onbase-app';

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

  const configResult = await getConnectorConfig(tenantRef.id, ONBASE_CONNECTOR, keyResult.val);
  if (!configResult.ok) {
    return NextResponse.json({ error: 'Could not read connector config' }, { status: 500 });
  }

  const config = configResult.val;
  const setting = (name: string): string | null => {
    const value = config?.settings[name];
    return typeof value === 'string' ? value : null;
  };
  return NextResponse.json({
    connector: ONBASE_CONNECTOR,
    configured: config !== null,
    enabled: config?.enabled ?? false,
    apiBaseUrl: setting('apiBaseUrl'),
    idpIssuer: setting('idpIssuer'),
    clientId: setting('clientId'),
    idpScopeName: setting('idpScopeName'),
    allowInsecureHttp: config?.settings.allowInsecureHttp === true,
    hasClientSecret: Boolean(config?.secrets.clientSecret),
    // Optional: unset means the onbase_admin_* tools are unavailable for
    // this tenant, never a broken Document API connection.
    adminApiBaseUrl: setting('adminApiBaseUrl'),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An absolute http(s) URL; https unless the operator allows insecure HTTP. */
function validBaseUrl(value: unknown, allowInsecureHttp: boolean): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password || url.search || url.hash) return false;
  return url.protocol === 'https:' || (allowInsecureHttp && url.protocol === 'http:');
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
  const allowInsecureHttp = body.allowInsecureHttp === true;
  const { apiBaseUrl, idpIssuer, clientId, idpScopeName, clientSecret, adminApiBaseUrl } = body;
  if (!validBaseUrl(apiBaseUrl, allowInsecureHttp)) {
    return NextResponse.json(
      { error: 'apiBaseUrl must be an absolute https URL (or http with insecure HTTP allowed)' },
      { status: 400 }
    );
  }
  if (!validBaseUrl(idpIssuer, allowInsecureHttp)) {
    return NextResponse.json(
      { error: 'idpIssuer must be an absolute https URL (or http with insecure HTTP allowed)' },
      { status: 400 }
    );
  }
  // Optional — omitted or blank simply leaves the onbase_admin_* tools
  // unavailable for this tenant.
  if (
    typeof adminApiBaseUrl === 'string' &&
    adminApiBaseUrl.length > 0 &&
    !validBaseUrl(adminApiBaseUrl, allowInsecureHttp)
  ) {
    return NextResponse.json(
      {
        error:
          'adminApiBaseUrl must be an absolute https URL (or http with insecure HTTP allowed), or omitted',
      },
      { status: 400 }
    );
  }
  if (typeof clientId !== 'string' || clientId.length === 0) {
    return NextResponse.json({ error: 'clientId is required' }, { status: 400 });
  }
  if (typeof idpScopeName !== 'string' || idpScopeName.length === 0) {
    return NextResponse.json({ error: 'idpScopeName is required' }, { status: 400 });
  }
  const enabled = typeof body.enabled === 'boolean' ? body.enabled : true;

  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  // Secrets survive settings-only saves: a blank/omitted secret keeps the
  // stored one. Unlike the SaaS connectors no secret is required at all —
  // a Hyland IdP client may be public (PKCE only).
  const existing = await getConnectorConfig(tenantRef.id, ONBASE_CONNECTOR, keyResult.val);
  const storedSecrets = existing.ok && existing.val ? existing.val.secrets : {};
  const mergedClientSecret =
    typeof clientSecret === 'string' && clientSecret.length > 0
      ? clientSecret
      : storedSecrets.clientSecret;

  const secrets: Record<string, string> = {};
  if (mergedClientSecret) {
    secrets.clientSecret = mergedClientSecret;
  }

  const writeResult = await setConnectorConfig(
    tenantRef.id,
    ONBASE_CONNECTOR,
    {
      enabled,
      settings: {
        apiBaseUrl,
        idpIssuer,
        clientId,
        idpScopeName,
        allowInsecureHttp,
        ...(typeof adminApiBaseUrl === 'string' && adminApiBaseUrl.length > 0
          ? { adminApiBaseUrl }
          : {}),
      },
      secrets,
    },
    keyResult.val
  );
  if (!writeResult.ok) {
    return NextResponse.json({ error: 'Could not store connector config' }, { status: 500 });
  }

  invalidateConnectorConfigCache(tenantRef.id, ONBASE_CONNECTOR);
  return NextResponse.json({
    connector: ONBASE_CONNECTOR,
    configured: true,
    enabled,
    hasClientSecret: Boolean(secrets.clientSecret),
  });
}
