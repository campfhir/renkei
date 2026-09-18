/**
 * Org-admin configuration of the voice connector — the speech service
 * behind the chat's read-aloud and voice mode. Same shape as web-search
 * and embeddings: one org-wide region (or custom endpoint) and key, no
 * OAuth. GET reports presence only; the key never leaves the server. See
 * packages/voice/src/config.ts for the settings/secrets keys this mirrors
 * — lib/voice/config.ts reads this same connector_configs row.
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
import {
  DEFAULT_AZURE_VOICE,
  DEFAULT_VOICE_LOCALE,
  VOICE_CONNECTOR,
  VOICE_PROVIDERS,
  normalizeEndpoint,
  normalizeLocale,
  normalizeRegion,
  parseVoiceProviderKind,
} from '@renkei/voice';
import { invalidateVoicesCache } from '@/lib/voice/config';
import { recordAuditEvent } from '@/lib/audit-events';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function settingString(settings: Record<string, unknown> | undefined, key: string): string | null {
  const value = settings?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

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

  const configResult = await getConnectorConfig(tenantRef.id, VOICE_CONNECTOR, keyResult.val);
  if (!configResult.ok) {
    return NextResponse.json({ error: 'Could not read connector config' }, { status: 500 });
  }

  const config = configResult.val;
  const settings = config?.settings;
  return NextResponse.json({
    connector: VOICE_CONNECTOR,
    configured: config !== null,
    enabled: config?.enabled ?? false,
    provider: parseVoiceProviderKind(settings?.provider) ?? 'azure-speech',
    providers: VOICE_PROVIDERS,
    region: settingString(settings, 'region'),
    endpoint: settingString(settings, 'endpoint'),
    defaultVoice: settingString(settings, 'defaultVoice') ?? DEFAULT_AZURE_VOICE,
    defaultLocale: settingString(settings, 'defaultLocale') ?? DEFAULT_VOICE_LOCALE,
    hasApiKey: Boolean(config?.secrets.apiKey),
  });
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

  const provider = parseVoiceProviderKind(body.provider ?? 'azure-speech');
  if (!provider) {
    return NextResponse.json(
      { error: `provider must be one of ${VOICE_PROVIDERS.join(', ')}` },
      { status: 400 }
    );
  }
  const rawRegion = typeof body.region === 'string' ? body.region.trim() : '';
  const region = rawRegion ? normalizeRegion(rawRegion) : null;
  if (rawRegion && !region) {
    return NextResponse.json(
      { error: 'region must be a bare region name such as eastus' },
      { status: 400 }
    );
  }
  const rawEndpoint = typeof body.endpoint === 'string' ? body.endpoint.trim() : '';
  const endpoint = rawEndpoint ? normalizeEndpoint(rawEndpoint) : null;
  if (rawEndpoint && !endpoint) {
    return NextResponse.json(
      { error: 'endpoint must be an https URL without a query string' },
      { status: 400 }
    );
  }
  if (!region && !endpoint) {
    return NextResponse.json(
      { error: 'A region or a custom endpoint is required' },
      { status: 400 }
    );
  }
  const rawLocale = typeof body.defaultLocale === 'string' ? body.defaultLocale.trim() : '';
  const defaultLocale = rawLocale ? normalizeLocale(rawLocale) : DEFAULT_VOICE_LOCALE;
  if (!defaultLocale) {
    return NextResponse.json(
      { error: 'defaultLocale must be a language tag such as en-US' },
      { status: 400 }
    );
  }
  const defaultVoice =
    typeof body.defaultVoice === 'string' && body.defaultVoice.trim()
      ? body.defaultVoice.trim().slice(0, 120)
      : DEFAULT_AZURE_VOICE;
  const enabled = typeof body.enabled === 'boolean' ? body.enabled : true;

  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  // Secrets survive settings-only saves: setConnectorConfig replaces secrets
  // wholesale, so a blank/omitted key is merged with the stored one here.
  const existing = await getConnectorConfig(tenantRef.id, VOICE_CONNECTOR, keyResult.val);
  const storedSecrets = existing.ok && existing.val ? existing.val.secrets : {};
  const submittedKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  const mergedApiKey = submittedKey || storedSecrets.apiKey;
  if (!mergedApiKey) {
    return NextResponse.json({ error: 'apiKey is required (none stored yet)' }, { status: 400 });
  }

  const writeResult = await setConnectorConfig(
    tenantRef.id,
    VOICE_CONNECTOR,
    {
      enabled,
      settings: {
        provider,
        region: region ?? '',
        endpoint: endpoint ?? '',
        defaultVoice,
        defaultLocale,
      },
      secrets: { apiKey: mergedApiKey },
    },
    keyResult.val
  );
  if (!writeResult.ok) {
    return NextResponse.json({ error: 'Could not store connector config' }, { status: 500 });
  }

  invalidateConnectorConfigCache(tenantRef.id, VOICE_CONNECTOR);
  invalidateVoicesCache(tenantRef.id);
  recordAuditEvent({
    tenantId: tenantRef.id,
    actorSubject: access.subject,
    action: 'connector.configured',
    targetKind: 'connector',
    targetLabel: VOICE_CONNECTOR,
    details: { provider, enabled, keyRotated: submittedKey !== '' },
  });
  return NextResponse.json({ connector: VOICE_CONNECTOR, configured: true, enabled });
}
