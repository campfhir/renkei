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
 *   - `max_completion_tokens`, not the deprecated `max_tokens`: the newer
 *     reasoning models reject the old name, and current chat models accept
 *     the new one everywhere this adapter targets.
 */

import { ok, err } from '@campfhir/safe-functions/helpers';
import { summarizeWireRequest } from './wire-summary';
import { looksLikeCredentialFailure } from './contract';
import type { Result } from '@campfhir/safe-functions/types';
import type {
  LlmContentBlock,
  LlmErrorKind,
  LlmMessage,
  LlmProvider,
  LlmRequest,
  LlmResponse,
} from './contract';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const REQUEST_TIMEOUT_MS = 120_000;

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

  async complete(request: LlmRequest): Promise<Result<LlmResponse, LlmErrorKind>> {
    // Tolerate a pasted FULL endpoint: the adapter appends /chat/completions
    // itself, so a base URL already ending in it would double the path.
    const baseUrl = (this.config.baseUrl || DEFAULT_BASE_URL)
      .replace(/\/+$/, '')
      .replace(/\/chat\/completions$/, '');
    const baseBody = {
      model: this.config.model,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(this.config.reasoningEffort ? { reasoning_effort: this.config.reasoningEffort } : {}),
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

    let response: Response;
    for (;;) {
      const body = {
        ...baseBody,
        ...(this.legacyMaxTokens
          ? { max_tokens: request.maxTokens }
          : { max_completion_tokens: request.maxTokens }),
      };
      try {
        const version = this.config.apiVersion
          ? `?api-version=${encodeURIComponent(this.config.apiVersion)}`
          : '';
        response = await fetch(`${baseUrl}/chat/completions${version}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.config.apiKey}`,
            'api-key': this.config.apiKey,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(request.timeoutMs ?? REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        const kind: LlmErrorKind =
          error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network';
        return err(kind, { message: error instanceof Error ? error.message : String(error) });
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
      break;
    }

    const raw: unknown = await response.json().catch(() => ({}));
    const payload: {
      choices?: unknown;
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
    } = typeof raw === 'object' && raw !== null ? raw : {};

    const choice: {
      message?: { content?: unknown; tool_calls?: unknown };
      finish_reason?: unknown;
    } =
      Array.isArray(payload.choices) &&
      typeof payload.choices[0] === 'object' &&
      payload.choices[0] !== null
        ? payload.choices[0]
        : {};

    const content: LlmContentBlock[] = [];
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

    const stopReason =
      choice.finish_reason === 'tool_calls'
        ? 'tool_use'
        : choice.finish_reason === 'length'
          ? 'max_tokens'
          : 'end_turn';

    return ok({
      content,
      stopReason,
      usage: {
        inputTokens:
          typeof payload.usage?.prompt_tokens === 'number' ? payload.usage.prompt_tokens : 0,
        outputTokens:
          typeof payload.usage?.completion_tokens === 'number'
            ? payload.usage.completion_tokens
            : 0,
      },
    });
  }
}
