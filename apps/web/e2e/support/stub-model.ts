/**
 * The stand-in model (e2e/llm-stub.mjs) on the org's roster, staged the
 * way an operator adds one: POST /api/admin/llm-models, and DELETE
 * /api/admin/llm-models/:id afterwards. The roster is organization-wide,
 * so the label carries the caller's own tag, the model is never the
 * default, and a spec names it on what it runs (an agent's or a chat's
 * `llmModelId`) instead of relying on the org default.
 *
 * The caller must be an operator (`roles: ['renkei-user', 'renkei-operator']`).
 */

import type { APIRequestContext } from '@playwright/test';
import { LLM_STUB_BASE_URL } from '../memory/constants';

export async function addStubModel(
  request: APIRequestContext,
  tag: string,
  /** More of the roster form's fields, e.g. `{ contextWindow: 200_000 }`. */
  extra: Record<string, unknown> = {}
): Promise<string> {
  const response = await request.post('/api/admin/llm-models', {
    data: {
      label: `Stub model ${tag}`,
      provider: 'openai',
      model: 'stub-model',
      baseUrl: LLM_STUB_BASE_URL,
      apiKey: 'stub-key',
      enabled: true,
      isDefault: false,
      ...extra,
    },
  });
  const body: unknown = await response.json();
  const id = typeof body === 'object' && body !== null && 'id' in body ? body.id : null;
  if (response.status() !== 201 || typeof id !== 'string') {
    throw new Error(
      `POST /api/admin/llm-models answered ${response.status()}: ${JSON.stringify(body)}`
    );
  }
  return id;
}

export async function removeModel(request: APIRequestContext, id: string): Promise<void> {
  // A kept-alive socket the server has just closed resets the first try
  // (after a long test the request context's connection sits idle); the
  // delete is safe to send again.
  const response = await request
    .delete(`/api/admin/llm-models/${id}`)
    .catch(() => request.delete(`/api/admin/llm-models/${id}`));
  if (!response.ok()) {
    throw new Error(`DELETE /api/admin/llm-models/${id} answered ${response.status()}`);
  }
}
