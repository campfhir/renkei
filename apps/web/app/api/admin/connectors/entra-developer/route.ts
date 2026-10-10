/**
 * Org-admin configuration of the Entra Developer app registration — the
 * SECOND Entra app, separate from the Microsoft 365 one (see
 * lib/entra-developer-app.ts). Same contract as the microsoft route: GET
 * reports presence only — secret values never leave the server — and the
 * scopes saved here ARE the org's ceiling, which a person connecting can
 * narrow, never widen.
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { loadKeyring } from '@renkei/crypto';
import {
  getConnectorConfig,
  setConnectorConfig,
  invalidateConnectorConfigCache,
} from '@renkei/connector-config';
import {
  ENTRA_DEVELOPER_CONNECTOR,
  DEFAULT_ENTRA_DEVELOPER_SCOPES,
} from '@/lib/entra-developer-app';

export async function GET(
  _request: NextRequest
): Promise<NextResponse> {
  const access = await checkAccess([ROLE_OPERATOR]);
  if (!access) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const keyResult = loadKeyring('TOKEN_ENCRYPTION_KEY');
  if (!keyResult.ok) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const configResult = await getConnectorConfig(
    ENTRA_DEVELOPER_CONNECTOR,
    keyResult.val
  );
  if (!configResult.ok) {
    return NextResponse.json({ error: 'Could not read connector config' }, { status: 500 });
  }

  const config = configResult.val;
  return NextResponse.json({
    connector: ENTRA_DEVELOPER_CONNECTOR,
    configured: config !== null,
    enabled: config?.enabled ?? false,
    clientId: typeof config?.settings.clientId === 'string' ? config.settings.clientId : null,
    directoryTenantId:
      typeof config?.settings.directoryTenantId === 'string'
        ? config.settings.directoryTenantId
        : null,
    scopes: typeof config?.settings.scopes === 'string' ? config.settings.scopes : null,
    hasClientSecret: Boolean(config?.secrets.clientSecret),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function PUT(
  request: NextRequest
): Promise<NextResponse> {
  const access = await checkAccess([ROLE_OPERATOR]);
  if (!access) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body: unknown = await request.json().catch(() => null);
  if (!isRecord(body)) {
    return NextResponse.json({ error: 'JSON body required' }, { status: 400 });
  }
  const { clientId, clientSecret, directoryTenantId } = body;
  if (typeof clientId !== 'string' || clientId.length === 0) {
    return NextResponse.json({ error: 'clientId is required' }, { status: 400 });
  }
  if (typeof directoryTenantId !== 'string' || directoryTenantId.length === 0) {
    return NextResponse.json(
      { error: 'directoryTenantId (the Entra directory / tenant ID) is required' },
      { status: 400 }
    );
  }
  const enabled = typeof body.enabled === 'boolean' ? body.enabled : true;
  const scopes =
    typeof body.scopes === 'string' && body.scopes ? body.scopes : DEFAULT_ENTRA_DEVELOPER_SCOPES;

  const keyResult = loadKeyring('TOKEN_ENCRYPTION_KEY');
  if (!keyResult.ok) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  // Secrets survive settings-only saves: setConnectorConfig replaces secrets
  // wholesale, so a blank/omitted secret is merged with the stored one here.
  // A secret is required only when none is stored yet.
  const existing = await getConnectorConfig(ENTRA_DEVELOPER_CONNECTOR, keyResult.val);
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

  const writeResult = await setConnectorConfig(
    ENTRA_DEVELOPER_CONNECTOR,
    {
      enabled,
      settings: { clientId, directoryTenantId, scopes },
      secrets: { clientSecret: mergedClientSecret },
    },
    keyResult.val
  );
  if (!writeResult.ok) {
    return NextResponse.json({ error: 'Could not store connector config' }, { status: 500 });
  }

  invalidateConnectorConfigCache(ENTRA_DEVELOPER_CONNECTOR);
  return NextResponse.json({ connector: ENTRA_DEVELOPER_CONNECTOR, configured: true, enabled });
}
