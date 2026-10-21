/**
 * Org-admin management of the Salesforce connectors (lib/salesforce-app.ts):
 * one per Salesforce org — production, each sandbox — each with its own My
 * Domain, consumer key and secret, on/off switch and capability ceiling.
 *
 * GET lists them, reporting only whether a secret is stored — secrets never
 * leave the server. PUT adds one (no `key`) or saves one (`key`), merging a
 * blank secret with the stored one. DELETE ?key= removes one; people's
 * connections to it stop working at once (the delegate carries no token for
 * an org that is not a connector), and it disappears from their cards.
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { loadKeyring } from '@renkei/crypto';
import {
  getConnectorConfig,
  setConnectorConfig,
  invalidateConnectorConfigCache,
  type ConnectorConfig,
} from '@renkei/connector-config';
import {
  orgSecretName,
  orgsFromSettings,
  validateOrg,
  type SalesforceOrg,
} from '@renkei/connector-salesforce';
import { SALESFORCE_CONNECTOR, DEFAULT_SALESFORCE_SCOPES } from '@/lib/salesforce-app';
import { ALL_SALESFORCE_SCOPES } from '@/lib/salesforce-scopes';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function load(): Promise<
  { ok: true; key: Buffer; config: ConnectorConfig | null } | { ok: false; response: NextResponse }
> {
  const access = await checkAccess([ROLE_OPERATOR]);
  if (!access) {
    return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }
  const keyResult = loadKeyring('TOKEN_ENCRYPTION_KEY');
  if (!keyResult.ok) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Server misconfigured' }, { status: 500 }),
    };
  }
  const configResult = await getConnectorConfig(SALESFORCE_CONNECTOR, keyResult.val);
  if (!configResult.ok) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Could not read connector config' }, { status: 500 }),
    };
  }
  return { ok: true, key: keyResult.val, config: configResult.val };
}

/** Saves the list; the type is switched on while it has any connector. */
async function save(
  key: Buffer,
  config: ConnectorConfig | null,
  orgs: SalesforceOrg[],
  secrets: Record<string, string>
): Promise<NextResponse | null> {
  const settings: Record<string, unknown> = {
    ...(config?.settings ?? {}),
    orgs: orgs.map((org) => ({
      key: org.key,
      name: org.name,
      myDomain: org.myDomain,
      sandbox: org.sandbox,
      enabled: org.enabled,
      clientId: org.clientId,
      scopes: org.scopes.join(' '),
    })),
  };
  const written = await setConnectorConfig(
    SALESFORCE_CONNECTOR,
    { enabled: orgs.length > 0, settings, secrets },
    key
  );
  if (!written.ok) {
    return NextResponse.json({ error: 'Could not store connector config' }, { status: 500 });
  }
  invalidateConnectorConfigCache(SALESFORCE_CONNECTOR);
  return null;
}

export async function GET(_request: NextRequest): Promise<NextResponse> {
  const loaded = await load();
  if (!loaded.ok) return loaded.response;
  const orgs = orgsFromSettings(loaded.config?.settings);
  return NextResponse.json({
    connector: SALESFORCE_CONNECTOR,
    configured: orgs.length > 0,
    enabled: loaded.config?.enabled ?? false,
    connectors: orgs.map((org) => ({
      key: org.key,
      name: org.name,
      myDomain: org.myDomain,
      sandbox: org.sandbox,
      enabled: org.enabled,
      clientId: org.clientId,
      scopes: org.scopes.join(' '),
      hasClientSecret: Boolean(loaded.config?.secrets[orgSecretName(org.key)]),
    })),
  });
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const loaded = await load();
  if (!loaded.ok) return loaded.response;
  const body: unknown = await request.json().catch(() => null);
  if (!isRecord(body)) {
    return NextResponse.json({ error: 'JSON body required' }, { status: 400 });
  }
  const orgs = orgsFromSettings(loaded.config?.settings);
  const existingKey = typeof body.key === 'string' && body.key ? body.key : undefined;
  if (existingKey && !orgs.some((org) => org.key === existingKey)) {
    return NextResponse.json({ error: 'No such Salesforce connector' }, { status: 404 });
  }
  const scopes =
    typeof body.scopes === 'string' && body.scopes.trim()
      ? body.scopes.split(/\s+/).filter(Boolean)
      : DEFAULT_SALESFORCE_SCOPES.split(' ');
  const unknown = scopes.filter((scope) => !ALL_SALESFORCE_SCOPES.includes(scope));
  if (unknown.length > 0) {
    return NextResponse.json(
      { error: `Unknown capabilities: ${unknown.join(', ')}` },
      { status: 400 }
    );
  }
  const checked = validateOrg({ ...body, scopes: [...new Set(scopes)] }, orgs, existingKey);
  if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });

  // Secrets survive settings-only saves: a blank secret keeps the stored one.
  const secrets = { ...(loaded.config?.secrets ?? {}) };
  const secretName = orgSecretName(checked.org.key);
  if (typeof body.clientSecret === 'string' && body.clientSecret.trim()) {
    secrets[secretName] = body.clientSecret.trim();
  }
  if (!secrets[secretName]) {
    return NextResponse.json(
      { error: 'The consumer secret is required (none stored yet)' },
      { status: 400 }
    );
  }
  const next = existingKey
    ? orgs.map((org) => (org.key === existingKey ? checked.org : org))
    : [...orgs, checked.org];
  const failed = await save(loaded.key, loaded.config, next, secrets);
  if (failed) return failed;
  return NextResponse.json({ connector: SALESFORCE_CONNECTOR, key: checked.org.key });
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const loaded = await load();
  if (!loaded.ok) return loaded.response;
  const key = new URL(request.url).searchParams.get('key') ?? '';
  const orgs = orgsFromSettings(loaded.config?.settings);
  if (!orgs.some((org) => org.key === key)) {
    return NextResponse.json({ error: 'No such Salesforce connector' }, { status: 404 });
  }
  const secrets = { ...(loaded.config?.secrets ?? {}) };
  delete secrets[orgSecretName(key)];
  const failed = await save(
    loaded.key,
    loaded.config,
    orgs.filter((org) => org.key !== key),
    secrets
  );
  if (failed) return failed;
  return NextResponse.json({ connector: SALESFORCE_CONNECTOR, removed: key });
}
