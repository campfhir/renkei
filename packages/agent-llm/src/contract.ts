/**
 * The provider-agnostic chat contract the agent engine runs against.
 *
 * Content blocks mirror Anthropic's Messages API shapes because they are
 * the most structured of the majors — OpenAI's flat `tool_calls` array and
 * Gemini's `functionCall` parts both map onto them losslessly, so each
 * adapter translates at its own edge and the engine never changes when a
 * provider is added.
 *
 * Errors are a closed taxonomy, not exceptions: the engine's behavior
 * differs by kind (an `auth` failure aborts the run — retrying cannot
 * help; a `rate_limit` nacks the queue job for backoff; a `timeout` costs
 * an attempt), so the kind IS the interface.
 */

import type { Result } from '@campfhir/safe-functions/types';

export type LlmContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean }
  /**
   * A file the model should SEE, not read about — a PDF page-rendered by
   * the provider (document) or a picture (image). Bytes ride as base64 in
   * a typed block the provider decodes; the model never receives base64
   * text. Anthropic renders documents natively; adapters for providers
   * without an equivalent degrade to a placeholder, so the engine can
   * attach these without knowing which provider is behind the run.
   */
  | { type: 'document'; mediaType: string; dataBase64: string; title?: string }
  | { type: 'image'; mediaType: string; dataBase64: string };

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: LlmContentBlock[];
}

export interface LlmToolDef {
  name: string;
  description: string;
  /** JSON Schema for the tool's input, as the provider expects it. */
  inputSchema: Record<string, unknown>;
}

export interface LlmRequest {
  system: string;
  messages: LlmMessage[];
  tools: LlmToolDef[];
  toolChoice?: 'auto' | 'any' | { name: string };
  maxTokens: number;
  temperature?: number;
  /**
   * Per-request wall-clock cap on the HTTP call, overriding the adapter's
   * 120s default. Callers that can afford a long think (the builder's
   * draft-from-description allows five minutes) raise it; the agents
   * engine deliberately stays on the default — a step's LLM call is
   * bounded tighter than an interactive drafting session.
   */
  timeoutMs?: number;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmResponse {
  content: LlmContentBlock[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens';
  usage: LlmUsage;
}

export type LlmErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'invalid_request'
  | 'overloaded'
  | 'provider_error'
  | 'timeout'
  | 'network';

export interface LlmProvider {
  complete(request: LlmRequest): Promise<Result<LlmResponse, LlmErrorKind>>;
}

/**
 * Whether an error body is a provider saying "your credential is no good",
 * whatever status it chose to say it with.
 *
 * This exists because the status alone lies in a case that matters: a
 * gateway sitting in front of the model (Azure, a corporate proxy, a load
 * balancer) answers a rejected upstream credential with 503, and 503
 * otherwise means "transient, retry me". Retrying is exactly wrong for a
 * dead API key — it can never come true, and meanwhile every triggering
 * event burns a run whose error blames the agent's step instead of the
 * org's model settings.
 *
 * Deliberately narrow: phrases that only appear when a credential is being
 * refused. A body merely containing the word "key" (a JSON parse complaint,
 * a schema error naming a field) must NOT land here — misclassifying a
 * transient fault as auth would abort runs that should have been retried,
 * which is the same bug pointing the other way.
 */
const CREDENTIAL_FAILURE_PHRASES = [
  'credential validation failed',
  'invalid api key',
  'invalid_api_key',
  'incorrect api key',
  'authentication_error',
  'authentication failed',
  'unauthorized',
  'permission_error',
];

export function looksLikeCredentialFailure(body: string): boolean {
  if (!body) return false;
  const haystack = body.toLowerCase();
  return CREDENTIAL_FAILURE_PHRASES.some((phrase) => haystack.includes(phrase));
}
