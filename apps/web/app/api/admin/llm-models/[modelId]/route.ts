/**
 * One model config: update and delete — operator-only.
 *
 * PUT merges a blank apiKey with the stored secret (the embeddings-route
 * rule: settings-only saves must not wipe the key). DELETE is allowed with
 * people still on the model: the projects, chats and agents set to it, and
 * the chat model preferences naming it, move to the model named in
 * `?replaceWith=`, or with none to "no model", which means the org default.
 * Either way each person it touched is told their model changed.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDataStore } from '@renkei/db';
import { decrypt, encrypt, loadKeyring } from '@renkei/crypto';
import { invalidateLlmCache } from '@renkei/agent-llm';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { parseModelPayload } from '@/lib/agents/llm-model-payload';
import { logger } from '@/lib/logger';
import { who } from '@/lib/log-actor';
import { patchChatModelPrefs, subjectsPreferringChatModel } from '@renkei/user-prefs';
import { modelRemovedUses, notifyModelRemoved } from '@/lib/agents/model-removed-notification';

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ modelId: string }> }
): Promise<NextResponse> {
  const { modelId } = await params;
  const session = await checkAccess([ROLE_OPERATOR]);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body: unknown = await request.json().catch(() => null);
  const parsed = parseModelPayload(body);
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const keyResult = loadKeyring('TOKEN_ENCRYPTION_KEY');
  if (!keyResult.ok) {
    logger.error(
      '{actor} saved the LLM model "{label}", but the token encryption key could not be loaded; nothing was saved: {error}',
      {
        component: 'api/admin/llm-models',
        ...who(session),
        modelId,
        label: parsed.label,
        error: keyResult.err.message ?? keyResult.err.type,
      }
    );
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

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
  request: NextRequest,
  { params }: { params: Promise<{ modelId: string }> }
): Promise<NextResponse> {
  const { modelId } = await params;
  const session = await checkAccess([ROLE_OPERATOR]);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const models = getDataStore().llmModels;
  const existing = await models.get(modelId);
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // The replacement has to be able to answer a chat: enabled, not an image model.
  const replaceWith = request.nextUrl.searchParams.get('replaceWith') || null;
  const replacement = replaceWith ? await models.findEnabledChatModel(replaceWith) : null;
  if (replaceWith && (!replacement || replacement.id === existing.id)) {
    return NextResponse.json(
      { error: 'The replacement must be another enabled chat model.' },
      { status: 400 }
    );
  }

  // Read before the delete: afterwards nothing says who was on it.
  const preferring = await subjectsPreferringChatModel(modelId);
  const people = modelRemovedUses(await models.usedBy(modelId), preferring);
  if (!(await models.delete(modelId, replacement?.id ?? null))) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  invalidateLlmCache();
  // The preferences name the model by id in their own documents, which the
  // delete does not reach: each moves to the replacement, or to none.
  const moved = await Promise.all(
    preferring.map((subject) => patchChatModelPrefs(subject, { modelId: replacement?.id ?? null }))
  );
  const unmoved = moved.filter((result) => !result.ok).length;
  if (unmoved > 0) {
    logger.warn(
      '{actor} removed the LLM model "{label}", but {unmoved} of the {preferring} chat model preferences naming it could not be rewritten; those people start new chats on the organization default',
      {
        component: 'api/admin/llm-models',
        ...who(session),
        modelId,
        label: existing.label,
        unmoved,
        preferring: preferring.length,
      }
    );
  }

  logger.info(
    '{actor} removed the LLM model "{label}"; what {people} people had set to it now uses {replacement}',
    {
      component: 'api/admin/llm-models',
      ...who(session),
      modelId,
      label: existing.label,
      people: people.length,
      replacement: replacement ? `"${replacement.label}"` : 'the organization default',
      replacementId: replacement?.id ?? null,
    }
  );
  await notifyModelRemoved({
    actorSubject: session.subject,
    label: existing.label,
    replacementLabel: replacement?.label ?? null,
    people,
  });

  return NextResponse.json({ deleted: true, notified: people.length });
}
