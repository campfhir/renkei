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
  /**
   * `partialJson` is never sent by a provider — it is a consumer's own
   * record of the raw `input_json_delta` text a block was still
   * streaming when its request ended without ever reaching this block's
   * `block_stop` (a timeout, an error, a cancel). `input` stays the `{}`
   * placeholder in that case; a consumer that persists blocks mid-stream
   * (the chat's turn-runner) carries this along so a record of an
   * unfinished call keeps the true partial arguments instead of a blank
   * object that looks like the model called the tool with nothing.
   */
  | { type: 'tool_use'; id: string; name: string; input: unknown; partialJson?: string }
  | {
      type: 'tool_result';
      toolUseId: string;
      content: string;
      isError?: boolean;
      /**
       * MCP Apps (SEP-1865): the `ui://` widget resource this result
       * renders as, and its data payload — stamped on by the chat's turn
       * runner when the call's tool declared `_meta.ui.resourceUri` (see
       * apps/web/lib/mcp-tools/widgets.ts). Neither field reaches the
       * actual provider request: every `toWire` in this package picks
       * fixed fields off a tool_result block, so these ride along in the
       * in-process message history and the encrypted chat row alone,
       * for the thread's own renderer to key off. `structuredContent` is
       * opaque here — each widget template defines its own shape.
       */
      uiResourceUri?: string;
      structuredContent?: unknown;
    }
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
   * Ask for extended thinking, with its text returned so it can be shown.
   * The budget is honored where the model takes one (Anthropic's
   * `{type: 'enabled', budget_tokens}` on models through Sonnet 4.5 and
   * Haiku 4.5); the 4.6-and-later generations decide their own depth
   * (`{type: 'adaptive'}`) and ignore it. The OpenAI dialect has no
   * per-request equivalent — reasoning effort is a per-model-config
   * setting there — so that adapter ignores it altogether.
   */
  thinking?: { budgetTokens: number };
  /**
   * Mark the stable prefix (tools, system) and the last content block of
   * the last message as cache breakpoints. The prefix markers are the
   * shared read point every call in a run or chat hits; the moving message
   * marker gives an agentic loop incremental caching — each turn reads the
   * previous turn's prefix and writes only its own delta. Anthropic needs
   * the explicit `cache_control` markers; other providers cache prefixes
   * implicitly or not at all and ignore the flag. Two calls with a shared
   * prefix already break even (a write costs 1.25×, a read 0.1×).
   */
  promptCache?: boolean;
}

export interface LlmUsage {
  /**
   * Every prompt token the model read this call, cache-served or not — the
   * number every usage view means by "input". Each adapter normalizes to
   * this: the OpenAI dialect's prompt_tokens already is it; Anthropic
   * reports the uncached remainder and the adapter folds the cache
   * portions back in.
   */
  inputTokens: number;
  outputTokens: number;
  /** The portion of inputTokens served from the provider's cache (billed at a discount). */
  cacheReadInputTokens?: number;
  /** The portion of inputTokens written to the cache this call (billed at a premium). */
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
 * Whether a base URL's host is an Azure endpoint (`*.azure.com`) — every
 * OpenAI-compatible adapter and models-listing helper special-cases these
 * (Azure's gateway fails a request carrying both credential headers, where
 * every other host tolerates it), so the hostname sniff is shared rather
 * than copied at each call site. A base URL that fails to parse is simply
 * not Azure, same as an empty one.
 */
export function isAzureHost(baseUrl: string): boolean {
  try {
    return /\.azure\.com$/i.test(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
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

/**
 * What every adapter attaches as a request-level failure's `err().cause`:
 * the exact request body sent, alongside a safe-to-display summary (see
 * wire-summary.ts) of the same. This exists so a real failure — the whole
 * reason someone is looking — can be diagnosed from what actually went
 * out on the wire instead of a guess: this package's own adapters were
 * built by reasoning about documentation and asking an operator to run
 * curl by hand, exactly because no request was ever captured anywhere.
 *
 * No credential ever lives here — auth rides in HTTP headers, which are
 * never part of `request` and never logged at all. That is also the only
 * thing worth encrypting at rest: `request` is plain prompt/tool content,
 * not a secret, so a caller logs it as ordinary text rather than under
 * secure() — the encrypt-at-rest path exists for credentials, and wrapping
 * a whole request body in it every time a call fails only inflates the
 * record for no protection anything here actually needs. Still clip it
 * before logging — the whole prompt history of a long-running chat is not
 * a reasonable log line — and never surface it on an admin-facing UI
 * verbatim, but plain text in the structured log is fine.
 */
export interface WireRequestCause {
  summary: string;
  request: Record<string, unknown>;
}

/** Narrows an `Err.cause` down to a `WireRequestCause`, for a logging call
 *  site that does not otherwise know what an adapter put there. */
export function wireRequestCauseOf(cause: unknown): WireRequestCause | null {
  if (typeof cause !== 'object' || cause === null) return null;
  const row: { summary?: unknown; request?: unknown } = cause;
  if (typeof row.summary !== 'string') return null;
  if (typeof row.request !== 'object' || row.request === null) return null;
  return { summary: row.summary, request: { ...row.request } };
}
