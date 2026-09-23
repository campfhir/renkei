/**
 * "Does this configuration actually answer?" — one real chat completion
 * through the same adapters a run uses, spoken directly from a draft
 * (provider/model/baseUrl/apiKey), never from a saved llm_model_configs row.
 *
 * This exists because listAvailableModels (models.ts) only proves the key
 * can list models — a wrong Azure deployment name, a model the account
 * can't reach, or a base URL that resolves but 404s the completions
 * endpoint all still list fine and only fail here, which is exactly the
 * class of mistake someone wants caught before saving, not after an
 * agent's first run.
 *
 * The request carries one harmless tool definition (TEST_TOOL) with
 * toolChoice 'auto', the same shape every real chat turn sends (the
 * engine always offers its active tool set) — a config that only breaks
 * once tools are present would otherwise sail through this test and only
 * fail in the first real chat. That's exactly how a gpt-6-astra-1 Azure
 * deployment failed once: it rejects any request carrying tool
 * definitions unless reasoning_effort is explicitly "none", a config a
 * toolless test call could never have caught. `toolChoice: 'auto'` means
 * the trivial prompt below has no reason to actually trigger a call, so a
 * normal provider still answers with the same plain-text reply.
 */

import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import type { LlmErrorKind, LlmToolDef } from './contract';
import { AnthropicProvider } from './anthropic';
import { OpenAiProvider } from './openai';

/** Interactive: someone clicked a button and is watching a spinner. */
const REQUEST_TIMEOUT_MS = 20_000;
const TEST_PROMPT = 'Reply with only the single word: ok';
const MAX_TOKENS = 16;
/** See the module doc: present so the test exercises the same
 *  tools-in-the-request shape a real chat turn always sends. */
const TEST_TOOL: LlmToolDef = {
  name: 'test_tool',
  description: 'Unused — present only to verify the model accepts tool definitions.',
  inputSchema: { type: 'object', properties: {} },
};

export interface TestConnectionConfig {
  provider: string;
  apiKey: string;
  model: string;
  baseUrl?: string | null;
  /** Azure surfaces version routes with ?api-version=; null = omit. */
  apiVersion?: string | null;
  /** OpenAI-dialect reasoning models' effort dial; null = omit. */
  reasoningEffort?: string | null;
}

export interface TestConnectionResult {
  model: string;
  /** The model's own reply text, trimmed — empty when it answered with
   *  something other than text (still a successful call). */
  reply: string;
}

export type TestConnectionError = LlmErrorKind | 'unsupported_provider';

export async function testLlmConnection(
  config: TestConnectionConfig
): Promise<Result<TestConnectionResult, TestConnectionError>> {
  const shared = {
    apiKey: config.apiKey,
    model: config.model,
    baseUrl: config.baseUrl ?? null,
    apiVersion: config.apiVersion ?? null,
  };

  let provider: AnthropicProvider | OpenAiProvider;
  switch (config.provider) {
    case 'anthropic':
      provider = new AnthropicProvider(shared);
      break;
    // The OpenAI-spec dialect covers OpenAI, Azure AI Foundry's v1 surface,
    // and self-hosted gateways — same as buildProvider() in resolve.ts.
    case 'openai':
      provider = new OpenAiProvider({ ...shared, reasoningEffort: config.reasoningEffort ?? null });
      break;
    // 'gemini' slots in here alongside resolve.ts's buildProvider().
    default:
      return err('unsupported_provider' as const, {
        message: `No adapter for provider "${config.provider}"`,
      });
  }

  const result = await provider.complete({
    system: '',
    messages: [{ role: 'user', content: [{ type: 'text', text: TEST_PROMPT }] }],
    tools: [TEST_TOOL],
    toolChoice: 'auto',
    maxTokens: MAX_TOKENS,
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
  if (!result.ok) return result;

  const reply = result.val.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('')
    .trim();
  return ok({ model: config.model, reply });
}
