/**
 * The stand-in model (e2e/llm-stub.mjs) on the org's roster, staged the
 * way an operator adds one: POST /api/admin/llm-models, and DELETE
 * /api/admin/llm-models/:id afterwards. The roster is organization-wide,
 * so the label carries the caller's own tag, the model is never the
 * default, and a spec names it on what it runs (an agent's or a chat's
 * `llmModelId`) instead of relying on the org default.
 *
 * What the model answers is scripted where it is sent, not here:
 * `stubScript(steps)` is the block llm-stub.mjs reads (its header has the
 * format) — put it in an agent's instructions, or append it to a prompt
 * with `scripted(text, steps)`.
 *
 * The caller must be an operator (`roles: ['renkei-user', 'renkei-operator']`).
 */

import type { APIRequestContext } from '@playwright/test';
import { LLM_STUB_BASE_URL } from '../memory/constants';

/** One model response; llm-stub.mjs plays them in order, a tool round trip apart. */
export interface StubStep {
  text?: string;
  reasoning?: string;
  tools?: { name: string; input?: Record<string, unknown> }[];
  usage?: { input: number; output: number; cached?: number };
  /** Held this long before answering. */
  delayMs?: number;
  /** Answers a one-shot call (a title, a digest, a summary) instead of a turn. */
  oneShot?: boolean;
}

/** The block llm-stub.mjs reads: the steps as base64 JSON, in short words so it wraps. */
export function stubScript(steps: readonly StubStep[]): string {
  const encoded = Buffer.from(JSON.stringify(steps)).toString('base64');
  return `[[stub-script]] ${encoded.match(/.{1,24}/g)?.join(' ') ?? ''} [[/stub-script]]`;
}

/** A prompt with its script after it. */
export function scripted(text: string, steps: readonly StubStep[]): string {
  return `${text}\n\n${stubScript(steps)}`;
}

/** A step calling one tool. */
export function toolStep(
  name: string,
  input: Record<string, unknown> = {},
  text?: string
): StubStep {
  return { tools: [{ name, input }], ...(text ? { text } : {}) };
}

export interface StubModelOptions {
  /** 'anthropic' for signed thinking and the composer's thinking switch. */
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

export async function addStubModel(
  request: APIRequestContext,
  tag: string,
  options: StubModelOptions = {}
): Promise<string> {
  const anthropic = options.provider === 'anthropic';
  const response = await request.post('/api/admin/llm-models', {
    data: {
      label: options.label ?? `Stub model ${tag}`,
      provider: options.provider ?? 'openai',
      // An Anthropic model's name picks its generation (thinking, limits).
      model: options.image?.model ?? (anthropic ? 'claude-sonnet-4-5' : 'stub-model'),
      baseUrl: anthropic ? LLM_STUB_BASE_URL.replace(/\/v1$/, '/anthropic') : LLM_STUB_BASE_URL,
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
