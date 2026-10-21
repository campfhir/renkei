/**
 * Org-admin configuration of the Salesforce CRM app (lib/salesforce-app.ts):
 * the consumer key and secret of the External Client App the organization
 * created in its own org, and that org's My Domain. Same contract as the
 * GitHub route: GET reports presence only — the secret never leaves the
 * server — and the capabilities saved here ARE the org's ceiling, which a
 * person connecting can narrow, never widen.
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { loadKeyring } from '@renkei/crypto';
import {
  getConnectorConfig,
  setConnectorConfig,
  invalidateConnectorConfigCache,
} from '@renkei/connector-config';
import { parseMyDomain } from '@renkei/connector-salesforce';
import { SALESFORCE_CONNECTOR, DEFAULT_SALESFORCE_SCOPES } from '@/lib/salesforce-app';
import { ALL_SALESFORCE_SCOPES } from '@/lib/salesforce-scopes';

export async function GET(_request: NextRequest): Promise<NextResponse> {
  const access = await checkAccess([ROLE_OPERATOR]);
  if (!access) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const keyResult = loadKeyring('TOKEN_ENCRYPTION_KEY');
  if (!keyResult.ok) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const configResult = await getConnectorConfig(SALESFORCE_CONNECTOR, keyResult.val);
  if (!configResult.ok) {
    return NextResponse.json({ error: 'Could not read connector config' }, { status: 500 });
  }

  const config = configResult.val;
  return NextResponse.json({
    connector: SALESFORCE_CONNECTOR,
    configured: config !== null,
    enabled: config?.enabled ?? false,
    clientId: typeof config?.settings.clientId === 'string' ? config.settings.clientId : null,
    myDomain: typeof config?.settings.myDomain === 'string' ? config.settings.myDomain : null,
    scopes: typeof config?.settings.scopes === 'string' ? config.settings.scopes : null,
    hasClientSecret: Boolean(config?.secrets.clientSecret),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const MY_DOMAIN_ERRORS: Record<string, string> = {
  NOT_A_URL: 'myDomain must be the org’s My Domain, like acme.my.salesforce.com',
  NOT_HTTPS: 'myDomain must be an https address',
  NOT_MY_DOMAIN:
    'myDomain must be the org’s own My Domain (…my.salesforce.com), not login.salesforce.com',
};

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const access = await checkAccess([ROLE_OPERATOR]);
  if (!access) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body: unknown = await request.json().catch(() => null);
  if (!isRecord(body)) {
    return NextResponse.json({ error: 'JSON body required' }, { status: 400 });
  }
  const { clientId, clientSecret } = body;
  if (typeof clientId !== 'string' || clientId.trim().length === 0) {
    return NextResponse.json({ error: 'clientId (the consumer key) is required' }, { status: 400 });
  }
  const myDomain = parseMyDomain(typeof body.myDomain === 'string' ? body.myDomain : '');
  if (!myDomain.ok) {
    return NextResponse.json({ error: MY_DOMAIN_ERRORS[myDomain.error] }, { status: 400 });
  }
  const enabled = typeof body.enabled === 'boolean' ? body.enabled : true;
  const requested =
    typeof body.scopes === 'string' && body.scopes
      ? body.scopes.split(/\s+/).filter(Boolean)
      : DEFAULT_SALESFORCE_SCOPES.split(' ');
  const unknown = requested.filter((scope) => !ALL_SALESFORCE_SCOPES.includes(scope));
  if (unknown.length > 0) {
    return NextResponse.json(
      { error: `Unknown capabilities: ${unknown.join(', ')}` },
      { status: 400 }
    );
  }

  const keyResult = loadKeyring('TOKEN_ENCRYPTION_KEY');
  if (!keyResult.ok) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  // Secrets survive settings-only saves: setConnectorConfig replaces secrets
  // wholesale, so a blank/omitted secret is merged with the stored one here.
  const existing = await getConnectorConfig(SALESFORCE_CONNECTOR, keyResult.val);
  const storedSecrets = existing.ok && existing.val ? existing.val.secrets : {};
  const mergedClientSecret =
    typeof clientSecret === 'string' && clientSecret.length > 0
      ? clientSecret
      : storedSecrets.clientSecret;
  if (!mergedClientSecret) {
    return NextResponse.json(
      { error: 'clientSecret (the consumer secret) is required (none stored yet)' },
      { status: 400 }
    );
  }

  const writeResult = await setConnectorConfig(
    SALESFORCE_CONNECTOR,
    {
      enabled,
      settings: {
        clientId: clientId.trim(),
        myDomain: myDomain.origin,
        scopes: [...new Set(requested)].join(' '),
      },
      secrets: { clientSecret: mergedClientSecret },
    },
    keyResult.val
  );
  if (!writeResult.ok) {
    return NextResponse.json({ error: 'Could not store connector config' }, { status: 500 });
  }

  invalidateConnectorConfigCache(SALESFORCE_CONNECTOR);
  return NextResponse.json({ connector: SALESFORCE_CONNECTOR, configured: true, enabled });
}
