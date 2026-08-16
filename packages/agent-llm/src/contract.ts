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
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean };

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
