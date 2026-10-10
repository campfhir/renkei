/**
 * Org-admin configuration of Renkei's GitHub App. Same shape as the
 * atlassian-bitbucket connector route, plus `appSlug` (github.com/apps/
 * <slug>) so the connect card can link to the App's own install page.
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { loadKeyring } from '@renkei/crypto';
import {
  getConnectorConfig,
  setConnectorConfig,
  invalidateConnectorConfigCache,
} from '@renkei/connector-config';
import { GITHUB_CONNECTOR, DEFAULT_GITHUB_SCOPES } from '@/lib/github-app';

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

  const configResult = await getConnectorConfig(GITHUB_CONNECTOR, keyResult.val);
  if (!configResult.ok) {
    return NextResponse.json({ error: 'Could not read connector config' }, { status: 500 });
  }

  const config = configResult.val;
  return NextResponse.json({
    connector: GITHUB_CONNECTOR,
    configured: config !== null,
    enabled: config?.enabled ?? false,
    clientId: typeof config?.settings.clientId === 'string' ? config.settings.clientId : null,
    appSlug: typeof config?.settings.appSlug === 'string' ? config.settings.appSlug : null,
    scopes: typeof config?.settings.scopes === 'string' ? config.settings.scopes : null,
    redirectUri:
      typeof config?.settings.redirectUri === 'string' ? config.settings.redirectUri : null,
    hasClientSecret: Boolean(config?.secrets.clientSecret),
    hasWebhookSecret: Boolean(config?.secrets.webhookSecret),
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
  const { clientId, clientSecret, appSlug, webhookSecret } = body;
  if (typeof clientId !== 'string' || clientId.length === 0) {
    return NextResponse.json({ error: 'clientId is required' }, { status: 400 });
  }
  const enabled = typeof body.enabled === 'boolean' ? body.enabled : true;
  const scopes =
    typeof body.scopes === 'string' && body.scopes ? body.scopes : DEFAULT_GITHUB_SCOPES;
  const redirectUri =
    typeof body.redirectUri === 'string' && body.redirectUri ? body.redirectUri : undefined;

  const keyResult = loadKeyring('TOKEN_ENCRYPTION_KEY');
  if (!keyResult.ok) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  // Secrets survive settings-only saves: setConnectorConfig replaces secrets
  // wholesale, so a blank/omitted secret is merged with the stored one here.
  // A secret is required only when none is stored yet.
  const existing = await getConnectorConfig(GITHUB_CONNECTOR, keyResult.val);
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
  // Optional: unset until an operator sets one, in which case the webhook
  // receiver (app/api/webhooks/github/route.ts) has nothing to
  // verify deliveries against and refuses them.
  const mergedWebhookSecret =
    typeof webhookSecret === 'string' && webhookSecret.length > 0
      ? webhookSecret
      : storedSecrets.webhookSecret;

  const settings: Record<string, unknown> = { clientId, scopes };
  if (redirectUri) settings.redirectUri = redirectUri;
  if (typeof appSlug === 'string' && appSlug) settings.appSlug = appSlug;

  const writeResult = await setConnectorConfig(
    GITHUB_CONNECTOR,
    {
      enabled,
      settings,
      secrets: {
        clientSecret: mergedClientSecret,
        ...(mergedWebhookSecret ? { webhookSecret: mergedWebhookSecret } : {}),
      },
    },
    keyResult.val
  );
  if (!writeResult.ok) {
    return NextResponse.json({ error: 'Could not store connector config' }, { status: 500 });
  }

  invalidateConnectorConfigCache(GITHUB_CONNECTOR);
  return NextResponse.json({
    connector: GITHUB_CONNECTOR,
    configured: true,
    enabled,
  });
}
