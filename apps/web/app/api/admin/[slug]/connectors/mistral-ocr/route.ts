/**
 * Org-admin configuration of the Mistral OCR connector (Mistral Document AI
 * on Microsoft Foundry) — same shape as embeddings/route.ts: one org-wide
 * endpoint + model + API key, no OAuth. GET reports presence only; the API
 * key never leaves the server. See packages/connector-mistral-ocr/src/config.ts
 * for the exact settings/secrets keys this mirrors (`endpoint`, `model`,
 * `apiKey`) — resolveMistralOcrConfig reads this same connector_configs row.
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
import { MISTRAL_OCR_CONNECTOR, DEFAULT_MISTRAL_OCR_MODEL } from '@renkei/connector-mistral-ocr';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

  const configResult = await getConnectorConfig(tenantRef.id, MISTRAL_OCR_CONNECTOR, keyResult.val);
  if (!configResult.ok) {
    return NextResponse.json({ error: 'Could not read connector config' }, { status: 500 });
  }

  const config = configResult.val;
  return NextResponse.json({
    connector: MISTRAL_OCR_CONNECTOR,
    configured: config !== null,
    enabled: config?.enabled ?? false,
    endpoint: typeof config?.settings.endpoint === 'string' ? config.settings.endpoint : null,
    model: typeof config?.settings.model === 'string' ? config.settings.model : null,
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
  const { endpoint, model, apiKey } = body;
  if (typeof endpoint !== 'string' || !endpoint) {
    return NextResponse.json({ error: 'endpoint is required' }, { status: 400 });
  }
  const enabled = typeof body.enabled === 'boolean' ? body.enabled : true;

  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  // Secrets survive settings-only saves: setConnectorConfig replaces secrets
  // wholesale, so a blank/omitted secret is merged with the stored one here.
  // A key is required only when none is stored yet.
  const existing = await getConnectorConfig(tenantRef.id, MISTRAL_OCR_CONNECTOR, keyResult.val);
  const storedSecrets = existing.ok && existing.val ? existing.val.secrets : {};
  const mergedApiKey = typeof apiKey === 'string' && apiKey ? apiKey : storedSecrets.apiKey;
  if (!mergedApiKey) {
    return NextResponse.json({ error: 'apiKey is required (none stored yet)' }, { status: 400 });
  }

  const writeResult = await setConnectorConfig(
    tenantRef.id,
    MISTRAL_OCR_CONNECTOR,
    {
      enabled,
      // model is optional — resolveMistralOcrConfig falls back to
      // DEFAULT_MISTRAL_OCR_MODEL when it's empty, so an empty string is
      // stored as-is rather than substituted here.
      settings: { endpoint, model: typeof model === 'string' ? model : '' },
      secrets: { apiKey: mergedApiKey },
    },
    keyResult.val
  );
  if (!writeResult.ok) {
    return NextResponse.json({ error: 'Could not store connector config' }, { status: 500 });
  }

  invalidateConnectorConfigCache(tenantRef.id, MISTRAL_OCR_CONNECTOR);
  return NextResponse.json({
    connector: MISTRAL_OCR_CONNECTOR,
    configured: true,
    enabled,
    defaultModel: DEFAULT_MISTRAL_OCR_MODEL,
  });
}
