/**
 * The OpenAI-spec adapter — one adapter for everything that speaks the
 * chat-completions dialect: OpenAI itself, Azure AI Foundry's
 * OpenAI-compatible v1 surface, and self-hosted gateways.
 *
 * Azure AI Foundry: set base_url to the resource's v1 surface
 * (https://{resource}.openai.azure.com/openai/v1) and `model` to the
 * DEPLOYMENT name. The key is sent as BOTH `Authorization: Bearer` and
 * `api-key` — OpenAI reads the first, classic Azure surfaces the second,
 * and each ignores the header it doesn't use.
 *
 * Translation notes (the contract's blocks are Anthropic-shaped):
 *   - tool_use → assistant `tool_calls` entries (arguments JSON-encoded);
 *     tool_result → its own `role: 'tool'` message keyed by tool_call_id.
 *   - thinking blocks have no wire form in this dialect and are dropped
 *     from history; a model that streams `reasoning_content` (DeepSeek and
 *     several gateways) has it surfaced as an unsigned thinking block.
 *   - `max_completion_tokens`, not the deprecated `max_tokens`: the newer
 *     reasoning models reject the old name, and current chat models accept
 *     the new one everywhere this adapter targets.
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
/** Content-index layout for a streamed reply: the dialect has no block
 *  indices of its own, so text, reasoning and each tool call get fixed
 *  slots that sort into the order a reader expects. */
const TEXT_INDEX = 0;
const REASONING_INDEX = 1;
const TOOL_INDEX_BASE = 100;

export interface OpenAiConfig {
  apiKey: string;
  /** Model id — for Azure AI Foundry, the deployment name. */
  model: string;
  baseUrl?: string | null;
  /** Azure surfaces version routes with ?api-version=; null = omit. */
  apiVersion?: string | null;
  /** Reasoning models' effort dial (minimal/low/medium/high); null = omit. */
  reasoningEffort?: string | null;
}

type WireMessage = Record<string, unknown>;

/**
 * One contract message → one or more wire messages: tool results must be
 * standalone `role: 'tool'` messages in this dialect.
 */
function toWireMessages(message: LlmMessage): WireMessage[] {
  if (message.role === 'assistant') {
    const text = message.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n');
    const toolCalls = message.content.flatMap((block) =>
      block.type === 'tool_use'
        ? [
            {
              id: block.id,
              type: 'function',
              function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
            },
          ]
        : []
    );
    // thinking / redacted_thinking: no wire form here — dropped.
    return [
      {
        role: 'assistant',
        content: text || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
    ];
  }

  const wire: WireMessage[] = [];
  let pendingText = '';
  const flushText = () => {
    if (!pendingText) return;
    wire.push({ role: 'user', content: pendingText });
    pendingText = '';
  };
  for (const block of message.content) {
    if (block.type === 'text') {
      pendingText += (pendingText ? '\n' : '') + block.text;
    } else if (block.type === 'tool_result') {
      flushText();
      wire.push({ role: 'tool', tool_call_id: block.toolUseId, content: block.content });
    } else if (block.type === 'image') {
      // Vision rides as a data-URL image part in this dialect.
      flushText();
      wire.push({
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: `data:${block.mediaType};base64,${block.dataBase64}` },
          },
        ],
      });
    } else if (block.type === 'document') {
      // No PDF part exists in the chat-completions dialect — degrade to a
      // visible placeholder rather than smuggling base64 as text. The tool
      // result alongside carries the extracted text either way.
      pendingText +=
        (pendingText ? '\n' : '') +
        `[Attached document${block.title ? ` "${block.title}"` : ''} (${block.mediaType}) ` +
        'cannot be displayed by this model provider — use the extracted text in the tool result.]';
    }
    // A tool_use in a user message has no wire form; the engine never builds one.
  }
  flushText();
  return wire;
}

function toolChoiceOf(request: LlmRequest): unknown {
  if (request.toolChoice === undefined || request.tools.length === 0) return undefined;
  if (request.toolChoice === 'auto') return 'auto';
  if (request.toolChoice === 'any') return 'required';
  return { type: 'function', function: { name: request.toolChoice.name } };
}

function errorKindOf(status: number, body = ''): LlmErrorKind {
  // See looksLikeCredentialFailure: a gateway in front of the model answers
  // a rejected upstream credential with 503, and retrying a dead key never
  // helps. The body is the honest signal; the status is not.
  if (looksLikeCredentialFailure(body)) return 'auth';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status === 400 || status === 404 || status === 413 || status === 422) {
    // 404 is in this bucket deliberately: on Azure it means "no such
    // deployment", which retrying can never fix.
    return 'invalid_request';
  }
  if (status === 503) return 'overloaded';
  return 'provider_error';
}

interface WireToolCall {
  id?: unknown;
  function?: { name?: unknown; arguments?: unknown };
}

function fromWireToolCall(call: WireToolCall): LlmContentBlock | null {
  const name = call.function?.name;
  if (typeof call.id !== 'string' || typeof name !== 'string') return null;
  let input: unknown = {};
  if (typeof call.function?.arguments === 'string' && call.function.arguments.trim()) {
    try {
      input = JSON.parse(call.function.arguments);
    } catch {
      // A model that emits broken JSON still called the tool; the engine's
      // input guard treats non-objects as empty args.
      input = {};
    }
  }
  return { type: 'tool_use', id: call.id, name, input };
}

function stopReasonOf(value: unknown): LlmResponse['stopReason'] {
  return value === 'tool_calls' ? 'tool_use' : value === 'length' ? 'max_tokens' : 'end_turn';
}

function usageOf(value: unknown): Partial<LlmUsage> {
  const usage: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    prompt_tokens_details?: { cached_tokens?: unknown };
  } = typeof value === 'object' && value !== null ? value : {};
  const out: Partial<LlmUsage> = {};
  if (typeof usage.prompt_tokens === 'number') out.inputTokens = usage.prompt_tokens;
  if (typeof usage.completion_tokens === 'number') out.outputTokens = usage.completion_tokens;
  if (typeof usage.prompt_tokens_details?.cached_tokens === 'number') {
    out.cacheReadInputTokens = usage.prompt_tokens_details.cached_tokens;
  }
  return out;
}

export class OpenAiProvider implements LlmProvider {
  /**
   * Which token-limit parameter this endpoint accepts. OpenAI's newer
   * models REQUIRE max_completion_tokens (and reject requests carrying
   * both), while many OpenAI-compatible servers — Foundry's open-weights
   * deployments like Kimi, older gateways — only know max_tokens. Sending
   * both is not an option (OpenAI 400s on the pair), so the adapter starts
   * with the modern name and falls back once on a 400 that names it,
   * remembering the answer for the instance's lifetime.
   */
  private legacyMaxTokens = false;

  constructor(private readonly config: OpenAiConfig) {}

  private endpoint(): { baseUrl: string; url: string } {
    // Tolerate a pasted FULL endpoint: the adapter appends /chat/completions
    // itself, so a base URL already ending in it would double the path.
    const baseUrl = (this.config.baseUrl || DEFAULT_BASE_URL)
      .replace(/\/+$/, '')
      .replace(/\/chat\/completions$/, '');
    const version = this.config.apiVersion
      ? `?api-version=${encodeURIComponent(this.config.apiVersion)}`
      : '';
    return { baseUrl, url: `${baseUrl}/chat/completions${version}` };
  }

  private baseBody(request: LlmRequest, stream: boolean): Record<string, unknown> {
    return {
      model: this.config.model,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(this.config.reasoningEffort ? { reasoning_effort: this.config.reasoningEffort } : {}),
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
      messages: [
        { role: 'system', content: request.system },
        ...request.messages.flatMap(toWireMessages),
      ],
      ...(request.tools.length > 0
        ? {
            tools: request.tools.map((tool) => ({
              type: 'function',
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
              },
            })),
          }
        : {}),
      ...(toolChoiceOf(request) !== undefined ? { tool_choice: toolChoiceOf(request) } : {}),
    };
  }

  /**
   * POST with the max-tokens fallback: a 400 naming max_completion_tokens
   * flips the instance to the legacy field and retries once. Only the
   * response is returned; parsing differs between the two verbs.
   */
  private async post(
    request: LlmRequest,
    stream: boolean,
    signal: AbortSignal,
    callerSignal?: AbortSignal
  ): Promise<Result<Response, LlmErrorKind>> {
    const { baseUrl, url } = this.endpoint();
    const baseBody = this.baseBody(request, stream);
    for (;;) {
      const body = {
        ...baseBody,
        ...(this.legacyMaxTokens
          ? { max_tokens: request.maxTokens }
          : { max_completion_tokens: request.maxTokens }),
      };
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.config.apiKey}`,
            'api-key': this.config.apiKey,
          },
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
        if (
          response.status === 400 &&
          !this.legacyMaxTokens &&
          /max_completion_tokens/.test(text)
        ) {
          this.legacyMaxTokens = true;
          continue;
        }
        return err(errorKindOf(response.status, text), {
          message: `OpenAI-compatible endpoint ${response.status}: ${text.slice(0, 500)}`,
          // The redacted request shape, for "what did we actually send"
          // troubleshooting — content replaced by lengths.
          cause: summarizeWireRequest(`${baseUrl}/chat/completions`, body),
        });
      }
      return ok(response);
    }
  }

  async complete(request: LlmRequest): Promise<Result<LlmResponse, LlmErrorKind>> {
    const posted = await this.post(
      request,
      false,
      AbortSignal.timeout(request.timeoutMs ?? REQUEST_TIMEOUT_MS)
    );
    if (!posted.ok) return posted;

    const raw: unknown = await posted.val.json().catch(() => ({}));
    const payload: { choices?: unknown; usage?: unknown } =
      typeof raw === 'object' && raw !== null ? raw : {};

    const choice: {
      message?: { content?: unknown; tool_calls?: unknown; reasoning_content?: unknown };
      finish_reason?: unknown;
    } =
      Array.isArray(payload.choices) &&
      typeof payload.choices[0] === 'object' &&
      payload.choices[0] !== null
        ? payload.choices[0]
        : {};

    const content: LlmContentBlock[] = [];
    if (typeof choice.message?.reasoning_content === 'string' && choice.message.reasoning_content) {
      content.push({ type: 'thinking', thinking: choice.message.reasoning_content });
    }
    if (typeof choice.message?.content === 'string' && choice.message.content) {
      content.push({ type: 'text', text: choice.message.content });
    }
    if (Array.isArray(choice.message?.tool_calls)) {
      for (const call of choice.message.tool_calls) {
        if (typeof call !== 'object' || call === null) continue;
        const block = fromWireToolCall(call);
        if (block) content.push(block);
      }
    }

    return ok({
      content,
      stopReason: stopReasonOf(choice.finish_reason),
      usage: { inputTokens: 0, outputTokens: 0, ...usageOf(payload.usage) },
    });
  }

  async stream(
    request: LlmRequest,
    options: LlmStreamOptions
  ): Promise<Result<LlmResponse, LlmErrorKind>> {
    const timeout = AbortSignal.timeout(request.timeoutMs ?? STREAM_TIMEOUT_MS);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const posted = await this.post(request, true, signal, options.signal);
    if (!posted.ok) return posted;
    if (!posted.val.body) {
      return err('provider_error' as const, { message: 'The endpoint returned no stream body.' });
    }

    const accumulator = createAccumulator();
    const emit = (event: LlmStreamEvent) => {
      accumulator.apply(event);
      options.onEvent(event);
    };
    const open = new Set<number>();
    const openBlock = (index: number, block: LlmContentBlock) => {
      if (open.has(index)) return;
      open.add(index);
      emit({ type: 'block_start', index, block });
    };
    // Tool calls are keyed by the dialect's own per-message index; a chunk
    // may carry the id/name once and arguments many times.
    const toolIndexes = new Map<number, number>();

    let stopReason: LlmResponse['stopReason'] | null = null;
    let usage: LlmUsage = { inputTokens: 0, outputTokens: 0 };
    let done = false;
    emit({ type: 'message_start' });

    try {
      for await (const message of readSseEvents(posted.val.body, { idleMs: STREAM_IDLE_MS })) {
        if (signal.aborted) break;
        if (message.data.trim() === '[DONE]') {
          done = true;
          break;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(message.data);
        } catch {
          continue;
        }
        const chunk: { choices?: unknown; usage?: unknown; error?: { message?: unknown } } =
          typeof parsed === 'object' && parsed !== null ? parsed : {};
        if (chunk.error) {
          const text = typeof chunk.error.message === 'string' ? chunk.error.message : '';
          return err(looksLikeCredentialFailure(text) ? 'auth' : 'provider_error', {
            message: `OpenAI-compatible stream error: ${text.slice(0, 500)}`,
          });
        }
        if (chunk.usage) usage = { ...usage, ...usageOf(chunk.usage) };

        const choice: {
          delta?: {
            content?: unknown;
            reasoning_content?: unknown;
            reasoning?: unknown;
            tool_calls?: unknown;
          };
          finish_reason?: unknown;
        } =
          Array.isArray(chunk.choices) &&
          typeof chunk.choices[0] === 'object' &&
          chunk.choices[0] !== null
            ? chunk.choices[0]
            : {};
        const delta = choice.delta ?? {};

        const reasoning =
          typeof delta.reasoning_content === 'string'
            ? delta.reasoning_content
            : typeof delta.reasoning === 'string'
              ? delta.reasoning
              : '';
        if (reasoning) {
          openBlock(REASONING_INDEX, { type: 'thinking', thinking: '' });
          emit({ type: 'thinking_delta', index: REASONING_INDEX, thinking: reasoning });
        }
        if (typeof delta.content === 'string' && delta.content) {
          openBlock(TEXT_INDEX, { type: 'text', text: '' });
          emit({ type: 'text_delta', index: TEXT_INDEX, text: delta.content });
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const call of delta.tool_calls) {
            const entry: {
              index?: unknown;
              id?: unknown;
              function?: { name?: unknown; arguments?: unknown };
            } = typeof call === 'object' && call !== null ? call : {};
            const callIndex = typeof entry.index === 'number' ? entry.index : toolIndexes.size;
            let index = toolIndexes.get(callIndex);
            if (index === undefined) {
              index = TOOL_INDEX_BASE + callIndex;
              toolIndexes.set(callIndex, index);
            }
            if (typeof entry.id === 'string' && typeof entry.function?.name === 'string') {
              openBlock(index, {
                type: 'tool_use',
                id: entry.id,
                name: entry.function.name,
                input: {},
              });
            }
            if (typeof entry.function?.arguments === 'string' && entry.function.arguments) {
              // Arguments before the id/name chunk would be lost on the
              // wire anyway; the accumulator buffers them by index.
              emit({ type: 'input_json_delta', index, partialJson: entry.function.arguments });
            }
          }
        }
        if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
          stopReason = stopReasonOf(choice.finish_reason);
          for (const index of [...open].sort((a, b) => a - b)) {
            emit({ type: 'block_stop', index });
          }
          open.clear();
        }
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
        message: 'The stream ended before the message was complete.',
      });
    }
    // Some gateways end without a finish_reason; treat [DONE] as end_turn.
    for (const index of [...open].sort((a, b) => a - b)) emit({ type: 'block_stop', index });
    emit({ type: 'message_end', stopReason: stopReason ?? 'end_turn', usage });
    return ok(accumulator.response());
  }
}
