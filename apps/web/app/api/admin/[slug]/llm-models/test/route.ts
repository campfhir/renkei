/**
 * "Test connection" for the model draft — operator-only, and the reason a
 * save doesn't have to be someone's first proof that a configuration works.
 *
 * One real chat completion through the production adapters, sent from the
 * unsaved draft (provider/model/baseUrl/apiKey), the same key-sourcing
 * rules as `available/route.ts`: a typed `apiKey` wins, else `modelConfigId`
 * lends an existing row's stored key without it ever reaching the browser.
 *
 * Deliberately distinct from `available/route.ts`: that route proves the
 * key can list models, which a wrong Azure deployment name or an
 * unreachable model still passes. This is the one that would have caught
 * it — nothing is stored here either way.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { decrypt, parseEncryptionKey } from '@renkei/crypto';
import { testLlmConnection, type TestConnectionError } from '@renkei/agent-llm';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { API_SURFACES, SUPPORTED_PROVIDERS } from '@/lib/agents/llm-model-payload';

/** The taxonomy, translated for the person watching the button spinner. */
function messageFor(kind: TestConnectionError): { message: string; status: number } {
  switch (kind) {
    case 'auth':
      return { message: 'The provider rejected the API key.', status: 400 };
    case 'unsupported_provider':
    case 'invalid_request':
      return {
        message: 'The provider did not understand the request — check the model id and base URL.',
        status: 400,
      };
    case 'rate_limit':
      return {
        message: 'The provider is rate-limiting this key — try again shortly.',
        status: 502,
      };
    case 'timeout':
    case 'network':
      return { message: 'Could not reach the provider — check the base URL.', status: 502 };
    default:
      return { message: 'The provider did not complete the test message.', status: 502 };
  }
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
  if (typeof body !== 'object' || body === null) {
    return NextResponse.json({ error: 'JSON body required' }, { status: 400 });
  }
  const payload: {
    provider?: unknown;
    model?: unknown;
    baseUrl?: unknown;
    apiVersion?: unknown;
    reasoningEffort?: unknown;
    apiSurface?: unknown;
    apiKey?: unknown;
    modelConfigId?: unknown;
  } = body;

  if (
    typeof payload.provider !== 'string' ||
    !SUPPORTED_PROVIDERS.some((provider) => provider === payload.provider)
  ) {
    return NextResponse.json(
      { error: `provider must be one of: ${SUPPORTED_PROVIDERS.join(', ')}` },
      { status: 400 }
    );
  }
  if (typeof payload.model !== 'string' || !payload.model.trim()) {
    return NextResponse.json({ error: 'model is required' }, { status: 400 });
  }

  let apiKey = typeof payload.apiKey === 'string' && payload.apiKey ? payload.apiKey : null;
  if (!apiKey && typeof payload.modelConfigId === 'string' && payload.modelConfigId) {
    const dbResult = getDatabase();
    if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });
    const row = await dbResult.val
      .selectFrom('llm_model_configs')
      .select(['encrypted_secrets'])
      .where('tenant_id', '=', tenant.id)
      .where('id', '=', payload.modelConfigId)
      .executeTakeFirst();
    if (!row) return NextResponse.json({ error: 'Model config not found' }, { status: 404 });

    const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
    if (!keyResult.ok) {
      return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
    }
    const secretsResult = row.encrypted_secrets
      ? decrypt(row.encrypted_secrets, keyResult.val)
      : null;
    if (secretsResult?.ok) {
      try {
        const secrets: { apiKey?: unknown } = JSON.parse(secretsResult.val);
        if (typeof secrets.apiKey === 'string') apiKey = secrets.apiKey;
      } catch {
        // Malformed secrets fall through to the no-key answer below.
      }
    }
  }
  if (!apiKey) {
    return NextResponse.json(
      { error: 'Provide an API key, or name a model config with one stored.' },
      { status: 400 }
    );
  }

  const result = await testLlmConnection({
    provider: payload.provider,
    apiKey,
    model: payload.model.trim(),
    baseUrl:
      typeof payload.baseUrl === 'string' && payload.baseUrl.trim() ? payload.baseUrl.trim() : null,
    apiVersion:
      typeof payload.apiVersion === 'string' && payload.apiVersion.trim()
        ? payload.apiVersion.trim()
        : null,
    reasoningEffort:
      typeof payload.reasoningEffort === 'string' && payload.reasoningEffort.trim()
        ? payload.reasoningEffort.trim()
        : null,
    apiSurface:
      typeof payload.apiSurface === 'string' &&
      API_SURFACES.some((surface) => surface === payload.apiSurface)
        ? payload.apiSurface
        : null,
  });
  if (!result.ok) {
    const { message, status } = messageFor(result.err.type);
    return NextResponse.json({ error: message }, { status });
  }

  return NextResponse.json({ ok: true, model: result.val.model, reply: result.val.reply });
}
