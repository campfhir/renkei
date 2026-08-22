/**
 * The Anthropic Messages API adapter — plain fetch, structurally a sibling
 * of OpenAiCompatibleEmbeddings (no SDK: the repo holds provider HTTP at
 * arm's length so a dependency's agenda never becomes the platform's).
 *
 * The contract's blocks are already Anthropic-shaped, so translation here
 * is a rename pass (toolUseId → tool_use_id), not a restructuring.
 */

import { ok, err } from '@campfhir/safe-functions/helpers';
import { summarizeWireRequest } from './wire-summary';
import type { Result } from '@campfhir/safe-functions/types';
import type {
  LlmContentBlock,
  LlmErrorKind,
  LlmProvider,
  LlmRequest,
  LlmResponse,
} from './contract';

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
const REQUEST_TIMEOUT_MS = 120_000;

export interface AnthropicConfig {
  apiKey: string;
  model: string;
  baseUrl?: string | null;
  /** Azure surfaces version routes with ?api-version=; null = omit. */
  apiVersion?: string | null;
}

function toWire(block: LlmContentBlock): Record<string, unknown> {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
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
  const block: { type?: unknown; text?: unknown; id?: unknown; name?: unknown; input?: unknown } =
    value;
  if (block.type === 'text' && typeof block.text === 'string') {
    return { type: 'text', text: block.text };
  }
  if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
    return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
  }
  // Thinking or other block types the engine has no use for: dropped, not fatal.
  return null;
}

function toolChoiceOf(request: LlmRequest): Record<string, unknown> | undefined {
  if (request.toolChoice === undefined || request.tools.length === 0) return undefined;
  if (request.toolChoice === 'auto') return { type: 'auto' };
  if (request.toolChoice === 'any') return { type: 'any' };
  return { type: 'tool', name: request.toolChoice.name };
}

function errorKindOf(status: number): LlmErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status === 400 || status === 413 || status === 422) return 'invalid_request';
  if (status === 529) return 'overloaded';
  return 'provider_error';
}

export class AnthropicProvider implements LlmProvider {
  constructor(private readonly config: AnthropicConfig) {}

  async complete(request: LlmRequest): Promise<Result<LlmResponse, LlmErrorKind>> {
    // Tolerate a pasted FULL endpoint: the adapter appends /v1/messages
    // itself, so a base URL already ending in it would double the path.
    const baseUrl = (this.config.baseUrl || DEFAULT_BASE_URL)
      .replace(/\/+$/, '')
      .replace(/\/v1\/messages$/, '');
    const body = {
      model: this.config.model,
      max_tokens: request.maxTokens,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      system: request.system,
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content.map(toWire),
      })),
      ...(request.tools.length > 0
        ? {
            tools: request.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.inputSchema,
            })),
          }
        : {}),
      ...(toolChoiceOf(request) ? { tool_choice: toolChoiceOf(request) } : {}),
    };

    let response: Response;
    try {
      const version = this.config.apiVersion
        ? `?api-version=${encodeURIComponent(this.config.apiVersion)}`
        : '';
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
      response = await fetch(`${baseUrl}/v1/messages${version}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...authHeaders,
          'anthropic-version': ANTHROPIC_VERSION,
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
      return err(errorKindOf(response.status), {
        message: `Anthropic ${response.status}: ${text.slice(0, 500)}`,
        // The redacted request shape, for "what did we actually send"
        // troubleshooting — content replaced by lengths.
        cause: summarizeWireRequest(`${baseUrl}/v1/messages`, body),
      });
    }

    const raw: unknown = await response.json().catch(() => ({}));
    const payload: {
      content?: unknown;
      stop_reason?: unknown;
      usage?: { input_tokens?: unknown; output_tokens?: unknown };
    } = typeof raw === 'object' && raw !== null ? raw : {};

    const content = Array.isArray(payload.content)
      ? payload.content.flatMap((block) => {
          const parsed = fromWire(block);
          return parsed ? [parsed] : [];
        })
      : [];
    const stopReason =
      payload.stop_reason === 'tool_use' || payload.stop_reason === 'max_tokens'
        ? payload.stop_reason
        : 'end_turn';

    return ok({
      content,
      stopReason,
      usage: {
        inputTokens:
          typeof payload.usage?.input_tokens === 'number' ? payload.usage.input_tokens : 0,
        outputTokens:
          typeof payload.usage?.output_tokens === 'number' ? payload.usage.output_tokens : 0,
      },
    });
  }
}
