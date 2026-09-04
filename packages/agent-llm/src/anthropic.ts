/**
 * The Anthropic Messages API adapter — plain fetch, structurally a sibling
 * of OpenAiCompatibleEmbeddings (no SDK: the repo holds provider HTTP at
 * arm's length so a dependency's agenda never becomes the platform's).
 *
 * The contract's blocks are already Anthropic-shaped, so translation here
 * is a rename pass (toolUseId → tool_use_id), not a restructuring. The
 * streaming path parses the Messages API's own SSE event vocabulary
 * (message_start, content_block_start/delta/stop, message_delta,
 * message_stop, ping, error) into the contract's events one-to-one.
 */

import { ok, err } from '@campfhir/safe-functions/helpers';
import { summarizeWireRequest } from './wire-summary';
import { looksLikeCredentialFailure, transportErrorKind } from './contract';
import { readSseEvents } from './sse-reader';
import { createAccumulator } from './stream-accumulator';
import type { Result } from '@campfhir/safe-functions/types';
import type {
  LlmContentBlock,
  LlmErrorKind,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStreamEvent,
  LlmStreamOptions,
  LlmUsage,
} from './contract';

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
const REQUEST_TIMEOUT_MS = 120_000;
/** A streamed answer can legitimately run for minutes; the idle guard is
 *  what catches a stall, not this. */
const STREAM_TIMEOUT_MS = 300_000;
const STREAM_IDLE_MS = 90_000;
/** Anthropic's floor for budget_tokens, and the headroom max_tokens must
 *  keep above it so the answer itself has room. */
const MIN_THINKING_BUDGET = 1_024;

export interface AnthropicConfig {
  apiKey: string;
  model: string;
  baseUrl?: string | null;
  /** Azure surfaces version routes with ?api-version=; null = omit. */
  apiVersion?: string | null;
}

function toWire(block: LlmContentBlock): Record<string, unknown> | null {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    // A thinking block goes back exactly as it came, signature included —
    // the API verifies it. One without a signature (a stream cut before
    // signature_delta, a reasoning summary from another provider) would be
    // rejected outright, so it is dropped here rather than failing the
    // whole request.
    case 'thinking':
      return block.signature
        ? { type: 'thinking', thinking: block.thinking, signature: block.signature }
        : null;
    case 'redacted_thinking':
      return { type: 'redacted_thinking', data: block.data };
    case 'tool_use':
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: block.toolUseId,
        content: block.content,
        ...(block.isError ? { is_error: true } : {}),
      };
    // The platform page-renders documents (image + text layer per page), so
    // the model reasons over layout, tables and figures — the whole reason
    // these exist instead of base64-in-text.
    case 'document':
      return {
        type: 'document',
        source: { type: 'base64', media_type: block.mediaType, data: block.dataBase64 },
        ...(block.title ? { title: block.title } : {}),
      };
    case 'image':
      return {
        type: 'image',
        source: { type: 'base64', media_type: block.mediaType, data: block.dataBase64 },
      };
  }
}

function fromWire(value: unknown): LlmContentBlock | null {
  if (typeof value !== 'object' || value === null) return null;
  const block: {
    type?: unknown;
    text?: unknown;
    id?: unknown;
    name?: unknown;
    input?: unknown;
    thinking?: unknown;
    signature?: unknown;
    data?: unknown;
  } = value;
  if (block.type === 'text' && typeof block.text === 'string') {
    return { type: 'text', text: block.text };
  }
  if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
    return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
  }
  if (block.type === 'thinking' && typeof block.thinking === 'string') {
    return {
      type: 'thinking',
      thinking: block.thinking,
      ...(typeof block.signature === 'string' ? { signature: block.signature } : {}),
    };
  }
  if (block.type === 'redacted_thinking' && typeof block.data === 'string') {
    return { type: 'redacted_thinking', data: block.data };
  }
  // Other block types the engine has no use for: dropped, not fatal.
  return null;
}

function toolChoiceOf(request: LlmRequest): Record<string, unknown> | undefined {
  if (request.toolChoice === undefined || request.tools.length === 0) return undefined;
  if (request.toolChoice === 'auto') return { type: 'auto' };
  if (request.toolChoice === 'any') return { type: 'any' };
  return { type: 'tool', name: request.toolChoice.name };
}

/**
 * The thinking parameter, or nothing when the request cannot carry one:
 * the API requires budget_tokens ≥ 1024 and < max_tokens, refuses a
 * temperature other than 1 alongside it, and only allows an `auto`
 * tool_choice — so a forced tool call (the engine's finish_step) and a
 * max_tokens too small to hold both the thinking and an answer simply
 * think in the open, as before.
 */
function thinkingOf(request: LlmRequest): { type: 'enabled'; budget_tokens: number } | undefined {
  if (!request.thinking) return undefined;
  if (request.toolChoice !== undefined && request.toolChoice !== 'auto') return undefined;
  const ceiling = request.maxTokens - MIN_THINKING_BUDGET;
  if (ceiling < MIN_THINKING_BUDGET) return undefined;
  const budget = Math.floor(Math.min(Math.max(request.thinking.budgetTokens, 0), ceiling));
  if (budget < MIN_THINKING_BUDGET) return undefined;
  return { type: 'enabled', budget_tokens: budget };
}

function usageOf(value: unknown): Partial<LlmUsage> {
  const usage: {
    input_tokens?: unknown;
    output_tokens?: unknown;
    cache_read_input_tokens?: unknown;
    cache_creation_input_tokens?: unknown;
  } = typeof value === 'object' && value !== null ? value : {};
  const out: Partial<LlmUsage> = {};
  if (typeof usage.input_tokens === 'number') out.inputTokens = usage.input_tokens;
  if (typeof usage.output_tokens === 'number') out.outputTokens = usage.output_tokens;
  if (typeof usage.cache_read_input_tokens === 'number') {
    out.cacheReadInputTokens = usage.cache_read_input_tokens;
  }
  if (typeof usage.cache_creation_input_tokens === 'number') {
    out.cacheWriteInputTokens = usage.cache_creation_input_tokens;
  }
  return out;
}

function stopReasonOf(value: unknown): LlmResponse['stopReason'] {
  return value === 'tool_use' || value === 'max_tokens' ? value : 'end_turn';
}

function errorKindOf(status: number, body = ''): LlmErrorKind {
  // The BODY outranks the status for credentials, because a gateway in front
  // of the model (Azure, a proxy, a load balancer) answers a bad upstream
  // credential with 503 rather than 401 — and 503 otherwise means "retry
  // me", which a wrong API key never outgrows. Misread once, that costs a
  // run per triggering event, blamed on the owner's step instead of the
  // org's model settings.
  if (looksLikeCredentialFailure(body)) return 'auth';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status === 400 || status === 413 || status === 422) return 'invalid_request';
  // 529 is Anthropic's own overload code; 502/503/504 are what a gateway
  // between us and it returns. All are worth retrying — the OpenAI adapter
  // has always treated 503 this way.
  if (status === 529 || status === 502 || status === 503 || status === 504) return 'overloaded';
  return 'provider_error';
}

/** A mid-stream `error` event's type → the taxonomy. */
function streamErrorKindOf(type: unknown, message: string): LlmErrorKind {
  if (looksLikeCredentialFailure(message)) return 'auth';
  switch (type) {
    case 'authentication_error':
    case 'permission_error':
      return 'auth';
    case 'rate_limit_error':
      return 'rate_limit';
    case 'overloaded_error':
      return 'overloaded';
    case 'invalid_request_error':
      return 'invalid_request';
    default:
      return 'provider_error';
  }
}

export class AnthropicProvider implements LlmProvider {
  constructor(private readonly config: AnthropicConfig) {}

  private endpoint(): { baseUrl: string; url: string } {
    // Tolerate a pasted FULL endpoint: the adapter appends /v1/messages
    // itself, so a base URL already ending in it would double the path.
    const baseUrl = (this.config.baseUrl || DEFAULT_BASE_URL)
      .replace(/\/+$/, '')
      .replace(/\/v1\/messages$/, '');
    const version = this.config.apiVersion
      ? `?api-version=${encodeURIComponent(this.config.apiVersion)}`
      : '';
    return { baseUrl, url: `${baseUrl}/v1/messages${version}` };
  }

  private headers(baseUrl: string): Record<string, string> {
    // Azure AI Foundry's gateway validates whichever credential headers it
    // sees, and a pile of them makes it fail ("credential validation
    // failed") even when one is right — so Azure hosts get EXACTLY the
    // headers Foundry's own sample curl sends: Bearer alone. Anthropic
    // direct keeps its own x-api-key alone; other gateways get both.
    const isAzure = /\.azure\.com$/i.test(new URL(baseUrl).hostname);
    const authHeaders: Record<string, string> = isAzure
      ? { authorization: `Bearer ${this.config.apiKey}` }
      : this.config.baseUrl
        ? {
            'x-api-key': this.config.apiKey,
            authorization: `Bearer ${this.config.apiKey}`,
          }
        : { 'x-api-key': this.config.apiKey };
    return {
      'content-type': 'application/json',
      ...authHeaders,
      'anthropic-version': ANTHROPIC_VERSION,
    };
  }

  private body(request: LlmRequest, stream: boolean): Record<string, unknown> {
    const thinking = thinkingOf(request);
    const tools = request.tools.map((tool, index) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
      // The cache breakpoint sits on the LAST tool: everything up to and
      // including it (system, tools) is the stable prefix a chat re-sends
      // every turn.
      ...(request.promptCache && index === request.tools.length - 1
        ? { cache_control: { type: 'ephemeral' } }
        : {}),
    }));
    return {
      model: this.config.model,
      max_tokens: request.maxTokens,
      // Extended thinking only runs at temperature 1, so the knob is
      // dropped rather than the request rejected.
      ...(request.temperature !== undefined && !thinking
        ? { temperature: request.temperature }
        : {}),
      ...(thinking ? { thinking } : {}),
      ...(stream ? { stream: true } : {}),
      // With caching on, the system prompt is its own breakpoint too, so a
      // request with no tools still caches its prefix.
      system: request.promptCache
        ? [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }]
        : request.system,
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content.flatMap((block) => {
          const wire = toWire(block);
          return wire ? [wire] : [];
        }),
      })),
      ...(tools.length > 0 ? { tools } : {}),
      ...(toolChoiceOf(request) ? { tool_choice: toolChoiceOf(request) } : {}),
    };
  }

  private async post(
    request: LlmRequest,
    body: Record<string, unknown>,
    signal: AbortSignal,
    callerSignal?: AbortSignal
  ): Promise<Result<Response, LlmErrorKind>> {
    const { baseUrl, url } = this.endpoint();
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: this.headers(baseUrl),
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      return err(transportErrorKind(error, callerSignal), {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return err(errorKindOf(response.status, text), {
        message: `Anthropic ${response.status}: ${text.slice(0, 500)}`,
        // The redacted request shape, for "what did we actually send"
        // troubleshooting — content replaced by lengths.
        cause: summarizeWireRequest(`${baseUrl}/v1/messages`, body),
      });
    }
    return ok(response);
  }

  async complete(request: LlmRequest): Promise<Result<LlmResponse, LlmErrorKind>> {
    const body = this.body(request, false);
    const posted = await this.post(
      request,
      body,
      AbortSignal.timeout(request.timeoutMs ?? REQUEST_TIMEOUT_MS)
    );
    if (!posted.ok) return posted;

    const raw: unknown = await posted.val.json().catch(() => ({}));
    const payload: { content?: unknown; stop_reason?: unknown; usage?: unknown } =
      typeof raw === 'object' && raw !== null ? raw : {};

    const content = Array.isArray(payload.content)
      ? payload.content.flatMap((block) => {
          const parsed = fromWire(block);
          return parsed ? [parsed] : [];
        })
      : [];

    return ok({
      content,
      stopReason: stopReasonOf(payload.stop_reason),
      usage: { inputTokens: 0, outputTokens: 0, ...usageOf(payload.usage) },
    });
  }

  async stream(
    request: LlmRequest,
    options: LlmStreamOptions
  ): Promise<Result<LlmResponse, LlmErrorKind>> {
    const body = this.body(request, true);
    const timeout = AbortSignal.timeout(request.timeoutMs ?? STREAM_TIMEOUT_MS);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const posted = await this.post(request, body, signal, options.signal);
    if (!posted.ok) return posted;
    if (!posted.val.body) {
      return err('provider_error' as const, { message: 'Anthropic returned no stream body.' });
    }

    const accumulator = createAccumulator();
    const emit = (event: LlmStreamEvent) => {
      accumulator.apply(event);
      options.onEvent(event);
    };
    let stopReason: LlmResponse['stopReason'] = 'end_turn';
    let usage: LlmUsage = { inputTokens: 0, outputTokens: 0 };
    let ended = false;

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
          index?: unknown;
          content_block?: unknown;
          delta?: unknown;
          message?: { usage?: unknown };
          usage?: unknown;
          error?: { type?: unknown; message?: unknown };
        } = typeof parsed === 'object' && parsed !== null ? parsed : {};
        const index = typeof frame.index === 'number' ? frame.index : 0;

        switch (frame.type) {
          case 'message_start': {
            const started = usageOf(frame.message?.usage);
            usage = { ...usage, ...started };
            emit({ type: 'message_start', usage: started });
            break;
          }
          case 'content_block_start': {
            const block = fromWire(frame.content_block);
            if (block) {
              // tool_use input arrives as JSON deltas; the start frame's
              // `{}` is a placeholder the accumulator overwrites.
              emit({
                type: 'block_start',
                index,
                block: block.type === 'tool_use' ? { ...block, input: {} } : block,
              });
            }
            break;
          }
          case 'content_block_delta': {
            const delta: {
              type?: unknown;
              text?: unknown;
              thinking?: unknown;
              signature?: unknown;
              partial_json?: unknown;
            } = typeof frame.delta === 'object' && frame.delta !== null ? frame.delta : {};
            if (delta.type === 'text_delta' && typeof delta.text === 'string') {
              emit({ type: 'text_delta', index, text: delta.text });
            } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
              emit({ type: 'thinking_delta', index, thinking: delta.thinking });
            } else if (delta.type === 'signature_delta' && typeof delta.signature === 'string') {
              emit({ type: 'signature_delta', index, signature: delta.signature });
            } else if (
              delta.type === 'input_json_delta' &&
              typeof delta.partial_json === 'string'
            ) {
              emit({ type: 'input_json_delta', index, partialJson: delta.partial_json });
            }
            break;
          }
          case 'content_block_stop':
            emit({ type: 'block_stop', index });
            break;
          case 'message_delta': {
            const delta: { stop_reason?: unknown } =
              typeof frame.delta === 'object' && frame.delta !== null ? frame.delta : {};
            if (delta.stop_reason !== undefined) stopReason = stopReasonOf(delta.stop_reason);
            usage = { ...usage, ...usageOf(frame.usage) };
            break;
          }
          case 'message_stop':
            ended = true;
            emit({ type: 'message_end', stopReason, usage });
            break;
          case 'error': {
            const text = typeof frame.error?.message === 'string' ? frame.error.message : '';
            return err(streamErrorKindOf(frame.error?.type, text), {
              message: `Anthropic stream error: ${text.slice(0, 500)}`,
            });
          }
          default:
            // ping, and anything newer than this adapter.
            break;
        }
        if (ended) break;
      }
    } catch (error) {
      return err(transportErrorKind(error, options.signal), {
        message: error instanceof Error ? error.message : String(error),
      });
    }

    if (!ended) {
      if (options.signal?.aborted) return err('aborted' as const, { message: 'Canceled.' });
      if (timeout.aborted) return err('timeout' as const, { message: 'The stream timed out.' });
      return err('provider_error' as const, {
        message: 'The stream ended before the message was complete.',
      });
    }
    return ok(accumulator.response());
  }
}
