/**
 * One model config: update and delete — operator-only.
 *
 * PUT merges a blank apiKey with the stored secret (the embeddings-route
 * rule: settings-only saves must not wipe the key). DELETE is allowed with
 * agents still pointing at the model — their llm_model_id FK sets NULL,
 * which means "use the org default", the least surprising degradation.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDataStore } from '@renkei/db';
import { decrypt, encrypt, loadKeyring } from '@renkei/crypto';
import { invalidateLlmCache } from '@renkei/agent-llm';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { parseModelPayload } from '@/lib/agents/llm-model-payload';

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ modelId: string }> }
): Promise<NextResponse> {
  const { modelId } = await params;
  if (!(await checkAccess([ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body: unknown = await request.json().catch(() => null);
  const parsed = parseModelPayload(body);
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const keyResult = loadKeyring('TOKEN_ENCRYPTION_KEY');
  if (!keyResult.ok) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  const models = getDataStore().llmModels;

  const existing = await models.get(modelId);
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // A blank apiKey keeps the stored one; a key is required only when none
  // is stored yet. `apiKeyFromId` borrows a sibling config's key instead —
  // the copied-encrypted-blob move the create route makes, so a fleet of
  // rows sharing one connection can be re-pointed without retyping it.
  let encryptedSecrets = existing.encryptedSecrets;
  if (parsed.apiKey) {
    encryptedSecrets = encrypt(JSON.stringify({ apiKey: parsed.apiKey }), keyResult.val);
  } else if (parsed.apiKeyFromId && parsed.apiKeyFromId !== modelId) {
    const source = await models.get(parsed.apiKeyFromId);
    if (!source?.encryptedSecrets) {
      return NextResponse.json(
        { error: 'The model to reuse the key from has no key stored.' },
        { status: 400 }
      );
    }
    encryptedSecrets = source.encryptedSecrets;
  } else if (!encryptedSecrets || !decrypt(encryptedSecrets, keyResult.val).ok) {
    return NextResponse.json({ error: 'apiKey is required (none stored yet)' }, { status: 400 });
  }

  const updated = await models.update(modelId, {
    label: parsed.label,
    provider: parsed.provider,
    model: parsed.model,
    baseUrl: parsed.baseUrl,
    settings: parsed.settings,
    encryptedSecrets,
    enabled: parsed.enabled,
    isDefault: parsed.isDefault,
  });
  if (updated === 'not-found') return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (updated === 'duplicate-label') {
    return NextResponse.json({ error: 'A model with this label already exists.' }, { status: 409 });
  }

  invalidateLlmCache();
  return NextResponse.json({ id: modelId });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ modelId: string }> }
): Promise<NextResponse> {
  const { modelId } = await params;
  if (!(await checkAccess([ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!(await getDataStore().llmModels.delete(modelId))) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  invalidateLlmCache();
  return NextResponse.json({ deleted: true });
}
