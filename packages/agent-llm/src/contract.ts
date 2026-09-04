/**
 * The provider-agnostic chat contract the agent engine and the chat run
 * against.
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
 *
 * Streaming is the second verb on the same contract. `stream()` delivers
 * the response as typed events while it is being generated and STILL
 * resolves with the assembled `LlmResponse`, so a consumer that wants to
 * show tokens as they arrive and a consumer that only wants the answer
 * read the same shape at the end. It is optional on the interface so the
 * request/response doubles the agent engine's tests use keep compiling;
 * `streamOrComplete` (stream-fallback.ts) papers over its absence.
 */

import type { Result } from '@campfhir/safe-functions/types';

export type LlmContentBlock =
  | { type: 'text'; text: string }
  /**
   * The model's extended thinking. `signature` is the provider's
   * attestation of the block (Anthropic issues one per thinking block);
   * a thinking block must be sent back to the SAME provider with its
   * signature intact when a tool-use turn continues, and a block that has
   * none (an interrupted stream, another provider's reasoning summary) is
   * dropped at the wire rather than rejected by the provider.
   */
  | { type: 'thinking'; thinking: string; signature?: string }
  /** Thinking the provider withheld and returns only as an opaque blob. */
  | { type: 'redacted_thinking'; data: string }
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
  /**
   * Ask for extended thinking with this token budget. Anthropic honors it
   * (`thinking: {type: 'enabled', budget_tokens}`); the OpenAI dialect has
   * no per-request equivalent — reasoning effort is a per-model-config
   * setting there — so the adapter ignores it.
   */
  thinking?: { budgetTokens: number };
  /**
   * Mark the system prompt and the tool list as cacheable. Anthropic's
   * prompt cache needs an explicit `cache_control` marker; other providers
   * cache implicitly or not at all and ignore the hint. Only worth setting
   * when the same prefix is re-sent turn after turn — the chat — because
   * a cache write costs more than a plain read.
   */
  promptCache?: boolean;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  /** Prompt tokens served from the provider's cache (billed at a discount). */
  cacheReadInputTokens?: number;
  /** Prompt tokens written to the cache this call (billed at a premium). */
  cacheWriteInputTokens?: number;
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
  | 'network'
  /** The caller's own AbortSignal fired — a cancel, not a fault. */
  | 'aborted';

/**
 * What a streaming call reports as it goes. Blocks are addressed by the
 * provider's own content index so deltas for a text block and a tool call
 * that interleave (Anthropic emits blocks strictly in order; the OpenAI
 * dialect can interleave text and tool_calls deltas) land on the right
 * block. `block_start` carries the block's skeleton — an empty text, an
 * empty thinking, a tool_use with `{}` input whose JSON arrives in
 * `input_json_delta` pieces — and `block_stop` closes it; a consumer that
 * only wants finished blocks can ignore everything between the two.
 */
export type LlmStreamEvent =
  | { type: 'message_start'; usage?: Partial<LlmUsage> }
  | { type: 'block_start'; index: number; block: LlmContentBlock }
  | { type: 'text_delta'; index: number; text: string }
  | { type: 'thinking_delta'; index: number; thinking: string }
  | { type: 'signature_delta'; index: number; signature: string }
  | { type: 'input_json_delta'; index: number; partialJson: string }
  | { type: 'block_stop'; index: number }
  | { type: 'message_end'; stopReason: LlmResponse['stopReason']; usage: LlmUsage };

export interface LlmStreamOptions {
  onEvent: (event: LlmStreamEvent) => void;
  /** Cancels the call; the result is then `err('aborted')`. */
  signal?: AbortSignal;
}

export interface LlmProvider {
  complete(request: LlmRequest): Promise<Result<LlmResponse, LlmErrorKind>>;
  /**
   * Stream the same call. Resolves with the assembled response after the
   * last event — identical to what `complete` would have returned — or
   * with the error kind; on a mid-stream failure the events already
   * delivered stand and the caller decides what to keep.
   */
  stream?(
    request: LlmRequest,
    options: LlmStreamOptions
  ): Promise<Result<LlmResponse, LlmErrorKind>>;
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

/**
 * The error kind for a thrown fetch/read failure: the caller's own cancel,
 * a deadline, or the network. Shared by both adapters so "the user clicked
 * Stop" is never reported as a timeout.
 */
export function transportErrorKind(error: unknown, signal?: AbortSignal): LlmErrorKind {
  if (signal?.aborted) return 'aborted';
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'IdleTimeoutError') return 'timeout';
    if (error.name === 'AbortError') return 'aborted';
  }
  return 'network';
}
