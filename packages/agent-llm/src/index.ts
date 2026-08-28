/**
 * @renkei/agent-llm — bring-your-own model access for agent runs.
 *
 * The platform hosts no models (Decision #8); it holds per-org model
 * configurations (llm_model_configs rows, keys sealed at rest) and speaks
 * each provider's HTTP API through an adapter implementing one contract.
 * Anthropic first; the contract is the part that must not move when
 * OpenAI/Gemini adapters arrive.
 */

export type {
  LlmContentBlock,
  LlmErrorKind,
  LlmMessage,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmToolDef,
  LlmUsage,
} from './contract';
export { AnthropicProvider, type AnthropicConfig } from './anthropic';
export { OpenAiProvider, type OpenAiConfig } from './openai';
export {
  listAvailableModels,
  type AvailableModel,
  type ListModelsConfig,
  type ListModelsError,
} from './models';
export {
  invalidateLlmCache,
  resolveAgentLlm,
  type ResolveLlmError,
  type ResolvedLlm,
} from './resolve';
