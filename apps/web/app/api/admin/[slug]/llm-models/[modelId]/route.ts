/**
 * One model config: update and delete — operator-only.
 *
 * PUT merges a blank apiKey with the stored secret (the embeddings-route
 * rule: settings-only saves must not wipe the key). DELETE is allowed with
 * agents still pointing at the model — their llm_model_id FK sets NULL,
 * which means "use the org default", the least surprising degradation.
 */

import { NextRequest, NextResponse } from 'next/server';
import { sql } from 'kysely';
import { getDatabase } from '@renkei/db';
import { decrypt, encrypt, parseEncryptionKey } from '@renkei/crypto';
import { invalidateLlmCache } from '@renkei/agent-llm';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { parseModelPayload } from '@/lib/agents/llm-model-payload';

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string; modelId: string }> }
): Promise<NextResponse> {
  const { slug, modelId } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  if (!(await checkAccess(tenant.id, [ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body: unknown = await request.json().catch(() => null);
  const parsed = parseModelPayload(body);
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });
  const db = dbResult.val;

  const existing = await db
    .selectFrom('llm_model_configs')
    .select(['id', 'encrypted_secrets'])
    .where('tenant_id', '=', tenant.id)
    .where('id', '=', modelId)
    .executeTakeFirst();
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // A blank apiKey keeps the stored one; a key is required only when none
  // is stored yet.
  let encryptedSecrets = existing.encrypted_secrets;
  if (parsed.apiKey) {
    encryptedSecrets = encrypt(JSON.stringify({ apiKey: parsed.apiKey }), keyResult.val);
  } else if (!encryptedSecrets || !decrypt(encryptedSecrets, keyResult.val).ok) {
    return NextResponse.json({ error: 'apiKey is required (none stored yet)' }, { status: 400 });
  }

  try {
    if (parsed.isDefault) {
      await db
        .updateTable('llm_model_configs')
        .set({ is_default: false, updated_at: sql`NOW()` })
        .where('tenant_id', '=', tenant.id)
        .where('is_default', '=', true)
        .where('id', '!=', modelId)
        .execute();
    }
    await db
      .updateTable('llm_model_configs')
      .set({
        label: parsed.label,
        provider: parsed.provider,
        model: parsed.model,
        base_url: parsed.baseUrl,
        settings: JSON.stringify(parsed.settings),
        encrypted_secrets: encryptedSecrets,
        enabled: parsed.enabled,
        is_default: parsed.isDefault,
        updated_at: sql`NOW()`,
      })
      .where('tenant_id', '=', tenant.id)
      .where('id', '=', modelId)
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
  return NextResponse.json({ id: modelId });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string; modelId: string }> }
): Promise<NextResponse> {
  const { slug, modelId } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  if (!(await checkAccess(tenant.id, [ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  const result = await dbResult.val
    .deleteFrom('llm_model_configs')
    .where('tenant_id', '=', tenant.id)
    .where('id', '=', modelId)
    .executeTakeFirst();
  if (Number(result.numDeletedRows ?? 0) === 0) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  invalidateLlmCache(tenant.id);
  return NextResponse.json({ deleted: true });
}
