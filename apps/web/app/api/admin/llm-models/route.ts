/**
 * The org's model roster (llm_model_configs) — operator-only.
 *
 * GET reports key PRESENCE, never keys (the embeddings-route rule). POST
 * creates a model; making it the default clears the previous default in
 * the same request, so the partial unique index never has to referee.
 */

import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { getDataStore } from '@renkei/db';
import { AAD_PURPOSE, aadFor, encrypt, loadKeyring } from '@renkei/crypto';
import { invalidateLlmCache } from '@renkei/agent-llm';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { parseModelPayload } from '@/lib/agents/llm-model-payload';
import { logger } from '@/lib/logger';

export async function GET(_request: NextRequest): Promise<NextResponse> {
  if (!(await checkAccess([ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const rows = await getDataStore().llmModels.list();

  return NextResponse.json({
    models: rows.map((row) => ({
      id: row.id,
      label: row.label,
      provider: row.provider,
      model: row.model,
      baseUrl: row.baseUrl,
      settings: row.settings,
      enabled: row.enabled,
      isDefault: row.isDefault,
      hasApiKey: Boolean(row.encryptedSecrets),
    })),
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!(await checkAccess([ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body: unknown = await request.json().catch(() => null);
  const parsed = parseModelPayload(body);
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
  if (!parsed.apiKey && !parsed.apiKeyFromId) {
    return NextResponse.json({ error: 'apiKey is required' }, { status: 400 });
  }

  const keyResult = loadKeyring('TOKEN_ENCRYPTION_KEY');
  if (!keyResult.ok) {
    logger.error('Could not load the token encryption key: {error}', {
      component: 'api/admin/llm-models',
      error: keyResult.err.message ?? keyResult.err.type,
    });
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const models = getDataStore().llmModels;

  // One connection, many model rows: the key can be borrowed from a sibling
  // config instead of retyped. Copying the encrypted blob is enough — every
  // row seals with the same deployment key — and the tenant predicate makes
  // someone else's config id come back empty, not copied.
  let encryptedSecrets = parsed.apiKey
    ? encrypt(
        JSON.stringify({ apiKey: parsed.apiKey }),
        keyResult.val,
        aadFor(AAD_PURPOSE.llmModelKey)
      )
    : null;
  if (!encryptedSecrets && parsed.apiKeyFromId) {
    const source = await models.get(parsed.apiKeyFromId);
    if (!source?.encryptedSecrets) {
      return NextResponse.json(
        { error: 'The model to reuse the key from has no key stored.' },
        { status: 400 }
      );
    }
    encryptedSecrets = source.encryptedSecrets;
  }
  if (!encryptedSecrets) return NextResponse.json({ error: 'apiKey is required' }, { status: 400 });

  const id = randomUUID();
  const created = await models.create(id, {
    label: parsed.label,
    provider: parsed.provider,
    model: parsed.model,
    baseUrl: parsed.baseUrl,
    settings: parsed.settings,
    encryptedSecrets,
    enabled: parsed.enabled,
    isDefault: parsed.isDefault,
  });
  if (created === 'duplicate-label') {
    return NextResponse.json({ error: 'A model with this label already exists.' }, { status: 409 });
  }

  invalidateLlmCache();
  return NextResponse.json({ id }, { status: 201 });
}
