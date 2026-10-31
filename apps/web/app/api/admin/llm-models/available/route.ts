/**
 * What models a connection can reach — operator-only, and the reason one
 * credential no longer means one hand-typed model row.
 *
 * POST because the request may carry an API key (a key in a query string
 * would land in access logs), even though it changes nothing: the route
 * relays a listing from the provider and stores nothing.
 *
 * The key comes from one of two places, checked in this order:
 *  - `apiKey` in the body — the create form, before anything is stored;
 *  - `modelConfigId` — an EXISTING config's stored key, decrypted here and
 *    lent to the listing without ever reaching the browser. The row must
 *    be this tenant's; the provider/baseUrl/apiVersion still come from the
 *    body, because the form's draft may have edited them and the listing
 *    should answer for what is on screen, not what was last saved.
 *
 * Lending a stored key to an operator-supplied base URL is not an
 * escalation: operators already point configs at any base_url they like,
 * and the worker then posts the same key there. Same trust, same key,
 * fewer moving parts.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDataStore } from '@renkei/db';
import { AAD_PURPOSE, aadFor, decryptBoundValue, loadKeyring } from '@renkei/crypto';
import { listAvailableModels, type ListModelsError } from '@renkei/agent-llm';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { SUPPORTED_PROVIDERS } from '@/lib/agents/llm-model-payload';
import { checkServiceEndpoint } from '@/lib/service-endpoint';
import { logger } from '@/lib/logger';

/** The taxonomy, translated for the person watching the button spinner. */
function messageFor(kind: ListModelsError): { message: string; status: number } {
  switch (kind) {
    case 'auth':
      return { message: 'The provider rejected the API key.', status: 400 };
    case 'unsupported_provider':
    case 'invalid_request':
      return {
        message: 'The provider did not understand the request — check the base URL.',
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
      return { message: 'The provider could not list its models right now.', status: 502 };
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
    baseUrl?: unknown;
    apiVersion?: unknown;
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
        component: 'api/admin/llm-models/available',
        error: keyResult.err.message ?? keyResult.err.type,
      });
      return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
    }
    const secretsResult = row.encryptedSecrets
      ? decryptBoundValue(row.encryptedSecrets, keyResult.val, aadFor(AAD_PURPOSE.llmModelKey))
      : null;
    if (secretsResult && !secretsResult.ok) {
      logger.warn(
        'Could not decrypt the stored API key for model config {modelConfigId}: {error}',
        {
          component: 'api/admin/llm-models/available',
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
          component: 'api/admin/llm-models/available',
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

  const result = await listAvailableModels({
    provider: payload.provider,
    apiKey,
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
  });
  if (!result.ok) {
    logger.warn('Listing models failed for {provider} ({kind}): {error}', {
      component: 'api/admin/llm-models/available',
      provider: payload.provider,
      kind: result.err.type,
      error: result.err.message ?? result.err.type,
    });
    const { message, status } = messageFor(result.err.type);
    return NextResponse.json({ error: message }, { status });
  }

  return NextResponse.json({ models: result.val });
}
