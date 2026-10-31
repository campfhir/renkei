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
import { getDataStore } from '@renkei/db';
import { decrypt, loadKeyring } from '@renkei/crypto';
import { testLlmConnection, type TestConnectionError } from '@renkei/agent-llm';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { API_SURFACES, SUPPORTED_PROVIDERS } from '@/lib/agents/llm-model-payload';
import { checkServiceEndpoint } from '@/lib/service-endpoint';
import { logger } from '@/lib/logger';

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

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!(await checkAccess([ROLE_OPERATOR]))) {
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
  // A stored key is only ever sent to the address it was stored for: a
  // base URL typed into the request cannot redirect it.
  let storedBaseUrl: string | null | undefined;
  if (!apiKey && typeof payload.modelConfigId === 'string' && payload.modelConfigId) {
    const row = await getDataStore().llmModels.get(payload.modelConfigId);
    if (!row) return NextResponse.json({ error: 'Model config not found' }, { status: 404 });
    storedBaseUrl = row.baseUrl;

    const keyResult = loadKeyring('TOKEN_ENCRYPTION_KEY');
    if (!keyResult.ok) {
      logger.error('Could not load the token encryption key: {error}', {
        component: 'api/admin/llm-models/test',
        error: keyResult.err.message ?? keyResult.err.type,
      });
      return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
    }
    const secretsResult = row.encryptedSecrets
      ? decrypt(row.encryptedSecrets, keyResult.val)
      : null;
    if (secretsResult && !secretsResult.ok) {
      logger.warn(
        'Could not decrypt the stored API key for model config {modelConfigId}: {error}',
        {
          component: 'api/admin/llm-models/test',
          modelConfigId: payload.modelConfigId,
          error: secretsResult.err.message ?? secretsResult.err.type,
        }
      );
    }
    if (secretsResult?.ok) {
      try {
        const secrets: { apiKey?: unknown } = JSON.parse(secretsResult.val);
        if (typeof secrets.apiKey === 'string') apiKey = secrets.apiKey;
      } catch (error) {
        // Malformed secrets fall through to the no-key answer below.
        logger.warn('Stored secrets for model config {modelConfigId} are malformed: {error}', {
          component: 'api/admin/llm-models/test',
          modelConfigId: payload.modelConfigId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  if (
    storedBaseUrl === undefined &&
    typeof payload.baseUrl === 'string' &&
    payload.baseUrl.trim()
  ) {
    const endpointVerdict = await checkServiceEndpoint(payload.baseUrl);
    if (!endpointVerdict.ok) {
      return NextResponse.json({ error: endpointVerdict.error }, { status: 400 });
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
      storedBaseUrl !== undefined
        ? storedBaseUrl
        : typeof payload.baseUrl === 'string' && payload.baseUrl.trim()
          ? payload.baseUrl.trim()
          : null,
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
    logger.warn('Model connection test failed for {provider} ({kind}): {error}', {
      component: 'api/admin/llm-models/test',
      provider: payload.provider,
      kind: result.err.type,
      error: result.err.message ?? result.err.type,
    });
    const { message, status } = messageFor(result.err.type);
    return NextResponse.json({ error: message }, { status });
  }

  return NextResponse.json({ ok: true, model: result.val.model, reply: result.val.reply });
}
