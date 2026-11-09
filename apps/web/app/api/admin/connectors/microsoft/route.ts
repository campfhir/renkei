/**
 * Org-admin configuration of the Microsoft (Entra) app registration the
 * Outlook connector runs through. GET reports presence only — secret values
 * never leave the server. The scopes saved here ARE the org's ceiling: a
 * user connecting can narrow their own grant within them, never widen.
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { loadKeyring } from '@renkei/crypto';
import {
  getConnectorConfig,
  setConnectorConfig,
  invalidateConnectorConfigCache,
} from '@renkei/connector-config';
import { MICROSOFT_CONNECTOR, DEFAULT_MICROSOFT_SCOPES } from '@/lib/microsoft-app';
import { logger } from '@/lib/logger';
import { who } from '@/lib/log-actor';
import { isRecord } from '@renkei/guards';

/** The connector as a log line names it. */
const CONNECTOR_LABEL = 'Microsoft 365';

export async function GET(_request: NextRequest): Promise<NextResponse> {
  const access = await checkAccess([ROLE_OPERATOR]);
  if (!access) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const keyResult = loadKeyring('TOKEN_ENCRYPTION_KEY');
  if (!keyResult.ok) {
    logger.error(
      '{actor} opened the {connector} connector settings, but the token encryption key could not be loaded; the page got a 500: {error}',
      {
        component: 'api/admin/connectors/microsoft',
        ...who(access),
        connector: CONNECTOR_LABEL,
        error: keyResult.err.message ?? keyResult.err.type,
      }
    );
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const configResult = await getConnectorConfig(MICROSOFT_CONNECTOR, keyResult.val);
  if (!configResult.ok) {
    logger.error(
      '{actor} opened the {connector} connector settings, but the stored configuration could not be read; the page got a 500: {error}',
      {
        component: 'api/admin/connectors/microsoft',
        ...who(access),
        connector: CONNECTOR_LABEL,
        error: configResult.err.message ?? configResult.err.type,
      }
    );
    return NextResponse.json({ error: 'Could not read connector config' }, { status: 500 });
  }

  const config = configResult.val;
  return NextResponse.json({
    connector: MICROSOFT_CONNECTOR,
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

export async function PUT(request: NextRequest): Promise<NextResponse> {
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
    typeof body.scopes === 'string' && body.scopes ? body.scopes : DEFAULT_MICROSOFT_SCOPES;

  const keyResult = loadKeyring('TOKEN_ENCRYPTION_KEY');
  if (!keyResult.ok) {
    logger.error(
      '{actor} saved the {connector} connector settings, but the token encryption key could not be loaded; nothing was saved: {error}',
      {
        component: 'api/admin/connectors/microsoft',
        ...who(access),
        connector: CONNECTOR_LABEL,
        error: keyResult.err.message ?? keyResult.err.type,
      }
    );
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  // Secrets survive settings-only saves: setConnectorConfig replaces secrets
  // wholesale, so a blank/omitted secret is merged with the stored one here.
  // A secret is required only when none is stored yet.
  const existing = await getConnectorConfig(MICROSOFT_CONNECTOR, keyResult.val);
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
    MICROSOFT_CONNECTOR,
    {
      enabled,
      settings: { clientId, directoryTenantId, scopes },
      secrets: { clientSecret: mergedClientSecret },
    },
    keyResult.val
  );
  if (!writeResult.ok) {
    logger.error(
      '{actor} saved the {connector} connector settings (switched {onOff}), but they were not stored: {error}',
      {
        component: 'api/admin/connectors/microsoft',
        ...who(access),
        connector: CONNECTOR_LABEL,
        enabled,
        onOff: enabled ? 'on' : 'off',
        error: writeResult.err.message ?? writeResult.err.type,
      }
    );
    return NextResponse.json({ error: 'Could not store connector config' }, { status: 500 });
  }

  invalidateConnectorConfigCache(MICROSOFT_CONNECTOR);
  return NextResponse.json({ connector: MICROSOFT_CONNECTOR, configured: true, enabled });
}
