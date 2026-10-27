/**
 * The stand-in model (e2e/llm-stub.mjs) on the org's roster, staged the
 * way an operator adds one: POST /api/admin/llm-models, and DELETE
 * /api/admin/llm-models/:id afterwards. The roster is organization-wide,
 * so the label carries the caller's own tag, the model is never the
 * default, and a spec names it on what it runs (an agent's or a chat's
 * `llmModelId`) instead of relying on the org default.
 *
 * A `script` makes it a scripted model: what it answers each chat turn —
 * text, reasoning, tool calls, usage, a delay — rides on its base URL
 * (llm-stub.mjs's header), so a turn the app really runs leaves exactly
 * the rows a spec needs.
 *
 * The caller must be an operator (`roles: ['renkei-user', 'renkei-operator']`).
 */

import type { APIRequestContext } from '@playwright/test';
import { LLM_STUB_BASE_URL } from '../memory/constants';

/** One model response: llm-stub.mjs plays these in order, a tool round trip apart. */
export interface StubStep {
  text?: string;
  reasoning?: string;
  tools?: { name: string; input?: Record<string, unknown> }[];
  usage?: { input: number; output: number; cached?: number };
  /** Held this long before answering. */
  delayMs?: number;
}

export interface StubReply {
  /** Text the person's last message contains; absent, any message. */
  when?: string;
  /** Also answer requests offering no tools (the one-shot title and summary calls). */
  untooled?: boolean;
  steps: StubStep[];
}

export interface StubModelOptions {
  script?: StubReply[];
  /**
   * The wire dialect: 'openai' (the default) or 'anthropic', for signed
   * thinking and the composer's thinking switch. Anthropic needs a script.
   */
  provider?: 'openai' | 'anthropic';
  /** Default `Stub model <tag>`. */
  label?: string;
  contextWindow?: number;
  /**
   * An image model instead of a chat one: `images` is answered by
   * llm-stub.mjs's Images endpoint; `flux` is a roster entry only.
   */
  image?: { apiSurface: 'images' | 'flux'; model: string };
}

export function stubBaseUrl(
  script?: StubReply[],
  provider: 'openai' | 'anthropic' = 'openai'
): string {
  const encoded = Buffer.from(JSON.stringify({ replies: script ?? [] })).toString('base64url');
  if (provider === 'anthropic') {
    return `${LLM_STUB_BASE_URL.replace(/\/v1$/, '')}/anthropic/script/${encoded}`;
  }
  if (!script) return LLM_STUB_BASE_URL;
  return `${LLM_STUB_BASE_URL}/script/${encoded}`;
}

export async function addStubModel(
  request: APIRequestContext,
  tag: string,
  options: StubModelOptions = {}
): Promise<string> {
  const response = await request.post('/api/admin/llm-models', {
    data: {
      label: options.label ?? `Stub model ${tag}`,
      provider: options.provider ?? 'openai',
      // An Anthropic model's name picks its generation (thinking, limits).
      model:
        options.image?.model ??
        (options.provider === 'anthropic' ? 'claude-sonnet-4-5' : 'stub-model'),
      baseUrl: stubBaseUrl(options.script, options.provider),
      apiKey: 'stub-key',
      enabled: true,
      isDefault: false,
      ...(options.contextWindow ? { contextWindow: options.contextWindow } : {}),
      ...(options.image
        ? {
            apiSurface: options.image.apiSurface,
            ...(options.image.apiSurface === 'flux' ? { apiVersion: 'preview' } : {}),
          }
        : {}),
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
  const response = await request.delete(`/api/admin/llm-models/${id}`);
  if (!response.ok()) {
    throw new Error(`DELETE /api/admin/llm-models/${id} answered ${response.status()}`);
  }
}
