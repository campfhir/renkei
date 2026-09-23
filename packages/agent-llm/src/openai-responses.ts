/**
 * The Responses API adapter — for the OpenAI-compatible reasoning models
 * that cannot do function/tool calling on the chat-completions dialect at
 * all: a gpt-6-astra-1 Azure deployment answers a chat-completions request
 * carrying `tools` with "Function tools with reasoning_effort are not
 * supported ... To use function tools, use /v1/responses or set
 * reasoning_effort to 'none'" — and, once `reasoning_effort` is set to
 * "none" as instructed, answers THAT with "Unsupported value: 'none' ...
 * Supported values are: 'low', 'medium', 'high', and 'xhigh'". No
 * reasoning_effort value unlocks tool calling on that dialect for this
 * model; `/v1/responses` is the only documented path.
 *
 * This is a genuinely different wire format from openai.ts's dialect, not
 * a variant of it: `input` items instead of `messages`, tool defs declared
 * flat (`{type:'function', name, ...}`, no nested `function` object)
 * instead of externally tagged, an `output` array of typed items instead
 * of `choices[].message`, tool calls and their results correlated by
 * `call_id` as their own item types (`function_call` /
 * `function_call_output`) instead of inline `tool_calls` +
 * `role:'tool'`, and a `reasoning: {effort}` object instead of a
 * top-level `reasoning_effort` string. Streaming is typed SSE events
 * (`response.output_text.delta`, `response.function_call_arguments.delta`,
 * `response.completed`, ...) rather than generic `delta` chunks with a
 * `[DONE]` sentinel.
 *
 * The `output_item.added` / `function_call_arguments.delta` / `.done` /
 * `output_item.done` / `response.completed` sequence below, and the
 * `function_call` → `function_call_output` round-trip shape, are verified
 * against a real Azure gpt-6-astra-1 deployment, not written from
 * documentation alone. The plain-text streaming path
 * (`response.output_text.delta`) and reasoning-summary items are inferred
 * from the same event family and OpenAI's published shape — every sample
 * pulled from the real deployment during development returned
 * `reasoning_tokens: 0` and never emitted a `reasoning` output item, so
 * that path has no real capture to verify against yet.
 */

import { ok, err } from '@campfhir/safe-functions/helpers';
import { summarizeWireRequest } from './wire-summary';
import { isAzureHost, looksLikeCredentialFailure, transportErrorKind } from './contract';
import { readSseEvents } from './sse-reader';
import { createAccumulator } from './stream-accumulator';
import type { Result } from '@campfhir/safe-functions/types';
import type {
  LlmContentBlock,
  LlmErrorKind,
  LlmMessage,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStreamEvent,
  LlmStreamOptions,
  LlmUsage,
} from './contract';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const REQUEST_TIMEOUT_MS = 120_000;
const STREAM_TIMEOUT_MS = 300_000;
const STREAM_IDLE_MS = 90_000;
/** Same cap as the chat-completions dialect (openai.ts) — no evidence this
 *  dialect's limit differs, and the engine's tool surface is assembled the
 *  same way regardless of which surface answers it. */
const MAX_TOOLS = 128;

export interface OpenAiResponsesConfig {
  apiKey: string;
  /** Model id — for Azure AI Foundry, the deployment name. */
  model: string;
  baseUrl?: string | null;
  /** Azure surfaces version routes with ?api-version=; null = omit. */
  apiVersion?: string | null;
  /** Sent as `reasoning: {effort}`, never the chat dialect's bare field. */
  reasoningEffort?: string | null;
}

type WireItem = Record<string, unknown>;

/**
 * One contract message → one or more input items. Mirrors openai.ts's
 * toWireMessages, translated to this dialect's item shapes: a tool result
 * is its own `function_call_output` item keyed by `call_id` (confirmed
 * against a real deployment), a tool call is a `function_call` item
 * (confirmed), and everything else groups into `role`-carrying items with
 * a `content` array of typed parts.
 */
function toWireItems(message: LlmMessage): WireItem[] {
  if (message.role === 'assistant') {
    const items: WireItem[] = [];
    const text = message.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n');
    if (text) {
      items.push({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text }],
      });
    }
    for (const block of message.content) {
      if (block.type === 'tool_use') {
        items.push({
          type: 'function_call',
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        });
      }
      // thinking / redacted_thinking: no wire form here — dropped, same as
      // openai.ts (this dialect's own reasoning items are opaque anyway,
      // carrying `encrypted_content` rather than text that could round-trip).
    }
    return items;
  }

  const items: WireItem[] = [];
  let pendingParts: Record<string, unknown>[] = [];
  const flushParts = () => {
    if (pendingParts.length === 0) return;
    items.push({ role: 'user', content: pendingParts });
    pendingParts = [];
  };
  for (const block of message.content) {
    if (block.type === 'text') {
      pendingParts.push({ type: 'input_text', text: block.text });
    } else if (block.type === 'tool_result') {
      flushParts();
      items.push({
        type: 'function_call_output',
        call_id: block.toolUseId,
        output: block.content,
      });
    } else if (block.type === 'image') {
      pendingParts.push({
        type: 'input_image',
        image_url: `data:${block.mediaType};base64,${block.dataBase64}`,
      });
    } else if (block.type === 'document') {
      // No native document handling implemented yet — same placeholder
      // degrade as openai.ts, kept consistent rather than adding a second
      // untested path (this dialect does have its own `input_file` item,
      // unverified here).
      pendingParts.push({
        type: 'input_text',
        text:
          `[Attached document${block.title ? ` "${block.title}"` : ''} (${block.mediaType}) ` +
          'cannot be displayed by this model provider — use the extracted text in the tool result.]',
      });
    }
    // A tool_use in a user message has no wire form; the engine never builds one.
  }
  flushParts();
  return items;
}

function toolChoiceOf(request: LlmRequest): unknown {
  if (request.toolChoice === undefined || request.tools.length === 0) return undefined;
  if (request.toolChoice === 'auto') return 'auto';
  if (request.toolChoice === 'any') return 'required';
  // Flat, not nested under `function` — this dialect's tools are
  // internally tagged (see the module doc); unverified against a real
  // named tool_choice call, but consistent with the confirmed tool-def
  // shape below.
  return { type: 'function', name: request.toolChoice.name };
}

function errorKindOf(status: number, body = ''): LlmErrorKind {
  if (looksLikeCredentialFailure(body)) return 'auth';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status === 400 || status === 404 || status === 413 || status === 422) {
    return 'invalid_request';
  }
  if (status === 503) return 'overloaded';
  return 'provider_error';
}

/** The response's own `error` field — confirmed present on a `status:
 *  "failed"` response even with a 200 status, unlike the chat-completions
 *  dialect where a failure is always a non-2xx HTTP status. */
function responseErrorMessage(value: unknown): string | null {
  const error: { message?: unknown } =
    typeof value === 'object' && value !== null ? value : {};
  return typeof error.message === 'string' && error.message ? error.message : null;
}

function usageOf(value: unknown): Partial<LlmUsage> {
  const usage: {
    input_tokens?: unknown;
    output_tokens?: unknown;
    input_tokens_details?: { cached_tokens?: unknown; cache_write_tokens?: unknown };
  } = typeof value === 'object' && value !== null ? value : {};
  const out: Partial<LlmUsage> = {};
  if (typeof usage.input_tokens === 'number') out.inputTokens = usage.input_tokens;
  if (typeof usage.output_tokens === 'number') out.outputTokens = usage.output_tokens;
  if (typeof usage.input_tokens_details?.cached_tokens === 'number') {
    out.cacheReadInputTokens = usage.input_tokens_details.cached_tokens;
  }
  if (
    typeof usage.input_tokens_details?.cache_write_tokens === 'number' &&
    usage.input_tokens_details.cache_write_tokens > 0
  ) {
    out.cacheWriteInputTokens = usage.input_tokens_details.cache_write_tokens;
  }
  return out;
}

/** A reasoning item's text, when it carries one — only present when the
 *  request asked for a summary (this adapter never does yet), so this
 *  will be empty on every capture taken so far. Not fatal either way: an
 *  item with no summary text is simply dropped, like an unsigned thinking
 *  block in anthropic.ts. */
function reasoningTextOf(summary: unknown): string {
  if (!Array.isArray(summary)) return '';
  return summary
    .flatMap((part) => {
      if (typeof part !== 'object' || part === null) return [];
      const row: { type?: unknown; text?: unknown } = part;
      return row.type === 'summary_text' && typeof row.text === 'string' ? [row.text] : [];
    })
    .join('\n');
}

/** One `output[]` item → zero or more contract blocks. Confirmed against a
 *  real deployment for `message` (text) and `function_call`; `reasoning`
 *  is handled defensively but never seen with content in practice. */
function fromWireOutputItem(item: unknown): LlmContentBlock[] {
  if (typeof item !== 'object' || item === null) return [];
  const row: {
    type?: unknown;
    content?: unknown;
    call_id?: unknown;
    name?: unknown;
    arguments?: unknown;
    summary?: unknown;
  } = item;
  if (row.type === 'message' && Array.isArray(row.content)) {
    return row.content.flatMap((part) => {
      if (typeof part !== 'object' || part === null) return [];
      const p: { type?: unknown; text?: unknown } = part;
      return p.type === 'output_text' && typeof p.text === 'string'
        ? [{ type: 'text' as const, text: p.text }]
        : [];
    });
  }
  if (row.type === 'function_call' && typeof row.call_id === 'string' && typeof row.name === 'string') {
    let input: unknown = {};
    if (typeof row.arguments === 'string' && row.arguments.trim()) {
      try {
        input = JSON.parse(row.arguments);
      } catch {
        input = {};
      }
    }
    return [{ type: 'tool_use', id: row.call_id, name: row.name, input }];
  }
  if (row.type === 'reasoning') {
    const text = reasoningTextOf(row.summary);
    return text ? [{ type: 'thinking', thinking: text }] : [];
  }
  // Other item types (image_generation_call, mcp_call, ...): no contract
  // shape to carry them yet — dropped, not fatal.
  return [];
}

export class OpenAiResponsesProvider implements LlmProvider {
  constructor(private readonly config: OpenAiResponsesConfig) {}

  private endpoint(): { baseUrl: string; url: string } {
    const baseUrl = (this.config.baseUrl || DEFAULT_BASE_URL)
      .replace(/\/+$/, '')
      .replace(/\/responses$/, '');
    const version = this.config.apiVersion
      ? `?api-version=${encodeURIComponent(this.config.apiVersion)}`
      : '';
    return { baseUrl, url: `${baseUrl}/responses${version}` };
  }

  private headers(baseUrl: string): Record<string, string> {
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${this.config.apiKey}`,
      ...(isAzureHost(baseUrl) ? {} : { 'api-key': this.config.apiKey }),
    };
  }

  private body(request: LlmRequest, stream: boolean): Record<string, unknown> {
    return {
      model: this.config.model,
      instructions: request.system,
      input: request.messages.flatMap(toWireItems),
      max_output_tokens: request.maxTokens,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(this.config.reasoningEffort ? { reasoning: { effort: this.config.reasoningEffort } } : {}),
      ...(stream ? { stream: true } : {}),
      ...(request.tools.length > 0
        ? {
            tools: request.tools.slice(0, MAX_TOOLS).map((tool) => ({
              type: 'function',
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
            })),
          }
        : {}),
      ...(toolChoiceOf(request) !== undefined ? { tool_choice: toolChoiceOf(request) } : {}),
    };
  }

  /** `body`/`headers` are built by the caller (complete()/stream()) rather
   *  than here, unlike openai.ts's version of this method — both need them
   *  again after a successful fetch (this dialect's own `status: "failed"`
   *  and `response.failed` cases arrive inside an otherwise-2xx/ok
   *  response, see below), and they double as the `cause` attached to
   *  every error. */
  private async post(
    url: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
    signal: AbortSignal,
    callerSignal?: AbortSignal
  ): Promise<Result<Response, LlmErrorKind>> {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      return err(transportErrorKind(error, callerSignal), {
        message: error instanceof Error ? error.message : String(error),
        cause: { summary: summarizeWireRequest(url, body), url, headers, request: body },
      });
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return err(errorKindOf(response.status, text), {
        message: `OpenAI Responses endpoint ${response.status}: ${text.slice(0, 500)}`,
        // The full request — URL (query params included), headers, and
        // body — alongside a redacted summary of the body; see
        // WireRequestCause's doc for why the credential in `headers`
        // is the one part a caller must mask before logging this.
        cause: { summary: summarizeWireRequest(url, body), url, headers, request: body },
      });
    }
    return ok(response);
  }

  async complete(request: LlmRequest): Promise<Result<LlmResponse, LlmErrorKind>> {
    const { baseUrl, url } = this.endpoint();
    const body = this.body(request, false);
    const headers = this.headers(baseUrl);
    const posted = await this.post(
      url,
      headers,
      body,
      AbortSignal.timeout(request.timeoutMs ?? REQUEST_TIMEOUT_MS)
    );
    if (!posted.ok) return posted;

    const raw: unknown = await posted.val.json().catch(() => ({}));
    const payload: { status?: unknown; output?: unknown; usage?: unknown; error?: unknown } =
      typeof raw === 'object' && raw !== null ? raw : {};

    // A "failed" response arrives with a 2xx HTTP status here — the
    // dialect's own status field, not the HTTP status, says whether it
    // worked (see the module doc).
    if (payload.status === 'failed') {
      const message = responseErrorMessage(payload.error) ?? 'The response failed.';
      return err(looksLikeCredentialFailure(message) ? 'auth' : 'provider_error', {
        message: `OpenAI Responses failed: ${message}`,
        cause: { summary: summarizeWireRequest(url, body), url, headers, request: body },
      });
    }

    const content = Array.isArray(payload.output) ? payload.output.flatMap(fromWireOutputItem) : [];
    const stopReason: LlmResponse['stopReason'] = content.some((block) => block.type === 'tool_use')
      ? 'tool_use'
      : 'end_turn';

    return ok({
      content,
      stopReason,
      usage: { inputTokens: 0, outputTokens: 0, ...usageOf(payload.usage) },
    });
  }

  async stream(
    request: LlmRequest,
    options: LlmStreamOptions
  ): Promise<Result<LlmResponse, LlmErrorKind>> {
    const timeout = AbortSignal.timeout(request.timeoutMs ?? STREAM_TIMEOUT_MS);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const { baseUrl, url } = this.endpoint();
    const body = this.body(request, true);
    const headers = this.headers(baseUrl);
    const posted = await this.post(url, headers, body, signal, options.signal);
    if (!posted.ok) return posted;
    if (!posted.val.body) {
      return err('provider_error' as const, { message: 'The endpoint returned no stream body.' });
    }

    const accumulator = createAccumulator();
    const emit = (event: LlmStreamEvent) => {
      accumulator.apply(event);
      options.onEvent(event);
    };
    // Unlike the chat-completions dialect, this one hands out a stable
    // `output_index` per item at `output_item.added` — no synthetic index
    // scheme needed.
    const open = new Set<number>();
    const openBlock = (index: number, block: LlmContentBlock) => {
      if (open.has(index)) return;
      open.add(index);
      emit({ type: 'block_start', index, block });
    };

    let stopReason: LlmResponse['stopReason'] | null = null;
    let usage: LlmUsage = { inputTokens: 0, outputTokens: 0 };
    let done = false;
    emit({ type: 'message_start' });

    try {
      for await (const message of readSseEvents(posted.val.body, { idleMs: STREAM_IDLE_MS })) {
        if (signal.aborted) break;
        let parsed: unknown;
        try {
          parsed = JSON.parse(message.data);
        } catch {
          continue;
        }
        const frame: {
          type?: unknown;
          item?: unknown;
          delta?: unknown;
          output_index?: unknown;
          response?: unknown;
          message?: unknown;
        } = typeof parsed === 'object' && parsed !== null ? parsed : {};
        const index = typeof frame.output_index === 'number' ? frame.output_index : 0;

        switch (frame.type) {
          // Confirmed shape: the item arrives fully identified (id, name,
          // call_id for a function_call; empty content for a message) —
          // deltas that follow only fill it in, so it opens here rather
          // than lazily on first delta the way the chat dialect must.
          case 'response.output_item.added': {
            const block = fromWireOutputItemSkeleton(frame.item);
            if (block) openBlock(index, block);
            break;
          }
          case 'response.output_text.delta': {
            openBlock(index, { type: 'text', text: '' });
            if (typeof frame.delta === 'string') {
              emit({ type: 'text_delta', index, text: frame.delta });
            }
            break;
          }
          case 'response.function_call_arguments.delta': {
            if (typeof frame.delta === 'string') {
              emit({ type: 'input_json_delta', index, partialJson: frame.delta });
            }
            break;
          }
          case 'response.reasoning_summary_text.delta': {
            openBlock(index, { type: 'thinking', thinking: '' });
            if (typeof frame.delta === 'string') {
              emit({ type: 'thinking_delta', index, thinking: frame.delta });
            }
            break;
          }
          case 'response.output_item.done': {
            if (open.has(index)) {
              emit({ type: 'block_stop', index });
              open.delete(index);
            }
            break;
          }
          case 'response.completed':
          case 'response.incomplete': {
            const resp: { usage?: unknown; incomplete_details?: { reason?: unknown } } =
              typeof frame.response === 'object' && frame.response !== null ? frame.response : {};
            if (resp.usage) usage = { ...usage, ...usageOf(resp.usage) };
            const maxedOut = resp.incomplete_details?.reason === 'max_output_tokens';
            stopReason = maxedOut
              ? 'max_tokens'
              : accumulator.response().content.some((block) => block.type === 'tool_use')
                ? 'tool_use'
                : 'end_turn';
            done = true;
            break;
          }
          case 'response.failed':
          case 'error': {
            const resp: { error?: unknown } =
              typeof frame.response === 'object' && frame.response !== null ? frame.response : {};
            const message =
              responseErrorMessage(resp.error) ??
              (typeof frame.message === 'string' ? frame.message : 'The response failed.');
            return err(looksLikeCredentialFailure(message) ? 'auth' : 'provider_error', {
              message: `OpenAI Responses stream error: ${message.slice(0, 500)}`,
              cause: { summary: summarizeWireRequest(url, body), url, headers, request: body },
            });
          }
          default:
            // response.created, response.in_progress, content_part.*, and
            // anything newer than this adapter.
            break;
        }
        if (done) break;
      }
    } catch (error) {
      return err(transportErrorKind(error, options.signal), {
        message: error instanceof Error ? error.message : String(error),
      });
    }

    if (stopReason === null && !done) {
      if (options.signal?.aborted) return err('aborted' as const, { message: 'Canceled.' });
      if (timeout.aborted) return err('timeout' as const, { message: 'The stream timed out.' });
      return err('provider_error' as const, {
        message: 'The stream ended before the response completed.',
      });
    }
    for (const index of [...open].sort((a, b) => a - b)) emit({ type: 'block_stop', index });
    emit({ type: 'message_end', stopReason: stopReason ?? 'end_turn', usage });
    return ok(accumulator.response());
  }
}

/** The empty skeleton a block opens with at `output_item.added`, before
 *  any deltas fill it in — mirrors fromWireOutputItem's type dispatch but
 *  never needs to parse `arguments`/`content` (both start empty on this
 *  event). A `reasoning` item without a requested summary opens nothing,
 *  matching fromWireOutputItem dropping it when its text is empty. */
function fromWireOutputItemSkeleton(item: unknown): LlmContentBlock | null {
  if (typeof item !== 'object' || item === null) return null;
  const row: { type?: unknown; call_id?: unknown; name?: unknown } = item;
  if (row.type === 'message') return { type: 'text', text: '' };
  if (row.type === 'function_call' && typeof row.call_id === 'string' && typeof row.name === 'string') {
    return { type: 'tool_use', id: row.call_id, name: row.name, input: {} };
  }
  return null;
}
