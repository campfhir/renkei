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
import { getDatabase } from '@renkei/db';
import { decrypt, parseEncryptionKey } from '@renkei/crypto';
import { listAvailableModels, type ListModelsError } from '@renkei/agent-llm';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { SUPPORTED_PROVIDERS } from '@/lib/agents/llm-model-payload';

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

  const result = await listAvailableModels({
    provider: payload.provider,
    apiKey,
    baseUrl:
      typeof payload.baseUrl === 'string' && payload.baseUrl.trim() ? payload.baseUrl.trim() : null,
    apiVersion:
      typeof payload.apiVersion === 'string' && payload.apiVersion.trim()
        ? payload.apiVersion.trim()
        : null,
  });
  if (!result.ok) {
    const { message, status } = messageFor(result.err.type);
    return NextResponse.json({ error: message }, { status });
  }

  return NextResponse.json({ models: result.val });
}
