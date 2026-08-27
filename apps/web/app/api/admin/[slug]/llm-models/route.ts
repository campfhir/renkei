/**
 * The org's model roster (llm_model_configs) — operator-only.
 *
 * GET reports key PRESENCE, never keys (the embeddings-route rule). POST
 * creates a model; making it the default clears the previous default in
 * the same request, so the partial unique index never has to referee.
 */

import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { getDatabase } from '@renkei/db';
import { encrypt, parseEncryptionKey } from '@renkei/crypto';
import { invalidateLlmCache } from '@renkei/agent-llm';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { parseModelPayload } from '@/lib/agents/llm-model-payload';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
): Promise<NextResponse> {
  const { slug } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  if (!(await checkAccess(tenant.id, [ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  const rows = await dbResult.val
    .selectFrom('llm_model_configs')
    .select([
      'id',
      'label',
      'provider',
      'model',
      'base_url',
      'settings',
      'enabled',
      'is_default',
      'encrypted_secrets',
    ])
    .where('tenant_id', '=', tenant.id)
    .orderBy('label')
    .execute();

  return NextResponse.json({
    models: rows.map((row) => ({
      id: row.id,
      label: row.label,
      provider: row.provider,
      model: row.model,
      baseUrl: row.base_url,
      settings: row.settings,
      enabled: row.enabled,
      isDefault: row.is_default,
      hasApiKey: Boolean(row.encrypted_secrets),
    })),
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
): Promise<NextResponse> {
  const { slug } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  if (!(await checkAccess(tenant.id, [ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body: unknown = await request.json().catch(() => null);
  const parsed = parseModelPayload(body);
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
  if (!parsed.apiKey && !parsed.apiKeyFromId) {
    return NextResponse.json({ error: 'apiKey is required' }, { status: 400 });
  }

  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });
  const db = dbResult.val;

  // One connection, many model rows: the key can be borrowed from a sibling
  // config instead of retyped. Copying the encrypted blob is enough — every
  // row seals with the same deployment key — and the tenant predicate makes
  // someone else's config id come back empty, not copied.
  let encryptedSecrets = parsed.apiKey
    ? encrypt(JSON.stringify({ apiKey: parsed.apiKey }), keyResult.val)
    : null;
  if (!encryptedSecrets && parsed.apiKeyFromId) {
    const source = await db
      .selectFrom('llm_model_configs')
      .select(['encrypted_secrets'])
      .where('tenant_id', '=', tenant.id)
      .where('id', '=', parsed.apiKeyFromId)
      .executeTakeFirst();
    if (!source?.encrypted_secrets) {
      return NextResponse.json(
        { error: 'The model to reuse the key from has no key stored.' },
        { status: 400 }
      );
    }
    encryptedSecrets = source.encrypted_secrets;
  }
  if (!encryptedSecrets) return NextResponse.json({ error: 'apiKey is required' }, { status: 400 });

  const id = randomUUID();
  try {
    if (parsed.isDefault) {
      await db
        .updateTable('llm_model_configs')
        .set({ is_default: false, updated_at: sql`NOW()` })
        .where('tenant_id', '=', tenant.id)
        .where('is_default', '=', true)
        .execute();
    }
    await db
      .insertInto('llm_model_configs')
      .values({
        id,
        tenant_id: tenant.id,
        label: parsed.label,
        provider: parsed.provider,
        model: parsed.model,
        base_url: parsed.baseUrl,
        settings: JSON.stringify(parsed.settings),
        encrypted_secrets: encryptedSecrets,
        enabled: parsed.enabled,
        is_default: parsed.isDefault,
      })
      .execute();
  } catch (error) {
    if (error instanceof Error && error.message.includes('llm_model_configs_tenant_label')) {
      return NextResponse.json(
        { error: 'A model with this label already exists.' },
        { status: 409 }
      );
    }
    throw error;
  }

  invalidateLlmCache(tenant.id);
  return NextResponse.json({ id }, { status: 201 });
}
