/**
 * Org-admin configuration of the embedding provider — models live outside
 * Renkei (Decision #8), and which endpoint, model, and key the org uses is
 * connector configuration in the database (Decision #19). GET reports
 * presence only; the API key never leaves the server.
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { getDatabase } from '@renkei/db';
import { parseEncryptionKey } from '@renkei/crypto';
import { parseMaxDistance } from '@renkei/knowledge';
import {
  getConnectorConfig,
  setConnectorConfig,
  invalidateConnectorConfigCache,
} from '@renkei/connector-config';

const EMBEDDINGS_CONNECTOR = 'embeddings';

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
  const access = await checkAccess(tenantId, [ROLE_OPERATOR]);
  if (!access) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const configResult = await getConnectorConfig(tenantId, EMBEDDINGS_CONNECTOR, keyResult.val);
  if (!configResult.ok) {
    return NextResponse.json({ error: 'Could not read connector config' }, { status: 500 });
  }

  const config = configResult.val;
  return NextResponse.json({
    connector: EMBEDDINGS_CONNECTOR,
    configured: config !== null,
    enabled: config?.enabled ?? false,
    baseUrl: typeof config?.settings.baseUrl === 'string' ? config.settings.baseUrl : null,
    model: typeof config?.settings.model === 'string' ? config.settings.model : null,
    hasApiKey: Boolean(config?.secrets.apiKey),
    queryPrefix:
      typeof config?.settings.queryPrefix === 'string' ? config.settings.queryPrefix : '',
    passagePrefix:
      typeof config?.settings.passagePrefix === 'string' ? config.settings.passagePrefix : '',
    maxDistance: parseMaxDistance(config?.settings.maxDistance),
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
  const access = await checkAccess(tenantId, [ROLE_OPERATOR]);
  if (!access) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body: unknown = await request.json().catch(() => null);
  if (!isRecord(body)) {
    return NextResponse.json({ error: 'JSON body required' }, { status: 400 });
  }
  const { baseUrl, model, apiKey } = body;
  if (typeof baseUrl !== 'string' || !baseUrl) {
    return NextResponse.json({ error: 'baseUrl is required' }, { status: 400 });
  }
  if (typeof model !== 'string' || !model) {
    return NextResponse.json({ error: 'model is required' }, { status: 400 });
  }
  const enabled = typeof body.enabled === 'boolean' ? body.enabled : true;

  // Per-model retrieval calibration, stored beside the model it describes.
  // Prefixes are kept verbatim (a trailing space is usually the point);
  // the cutoff is a positive cosine distance or absent — blank clears it.
  const queryPrefix = typeof body.queryPrefix === 'string' ? body.queryPrefix : '';
  const passagePrefix = typeof body.passagePrefix === 'string' ? body.passagePrefix : '';
  const rawMaxDistance = body.maxDistance;
  const maxDistanceBlank =
    rawMaxDistance === undefined ||
    rawMaxDistance === null ||
    (typeof rawMaxDistance === 'string' && !rawMaxDistance.trim());
  const maxDistance = maxDistanceBlank ? null : parseMaxDistance(rawMaxDistance);
  if (!maxDistanceBlank && (maxDistance === null || maxDistance > 2)) {
    return NextResponse.json(
      { error: 'maxDistance must be a cosine distance between 0 and 2, or blank' },
      { status: 400 }
    );
  }

  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  // Secrets survive settings-only saves: setConnectorConfig replaces secrets
  // wholesale, so a blank/omitted secret is merged with the stored one here.
  // A key is required only when none is stored yet.
  const existing = await getConnectorConfig(tenantId, EMBEDDINGS_CONNECTOR, keyResult.val);
  const storedSecrets = existing.ok && existing.val ? existing.val.secrets : {};
  const mergedApiKey = typeof apiKey === 'string' && apiKey ? apiKey : storedSecrets.apiKey;
  if (!mergedApiKey) {
    return NextResponse.json({ error: 'apiKey is required (none stored yet)' }, { status: 400 });
  }

  const writeResult = await setConnectorConfig(
    tenantId,
    EMBEDDINGS_CONNECTOR,
    {
      enabled,
      settings: { baseUrl, model, queryPrefix, passagePrefix, maxDistance },
      secrets: { apiKey: mergedApiKey },
    },
    keyResult.val
  );
  if (!writeResult.ok) {
    return NextResponse.json({ error: 'Could not store connector config' }, { status: 500 });
  }

  invalidateConnectorConfigCache(tenantId, EMBEDDINGS_CONNECTOR);
  return NextResponse.json({ connector: EMBEDDINGS_CONNECTOR, configured: true, enabled });
}
