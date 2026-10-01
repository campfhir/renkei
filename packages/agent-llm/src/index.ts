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
  LlmStreamEvent,
  LlmStreamOptions,
  LlmToolDef,
  LlmUsage,
  WireRequestCause,
} from './contract';
export {
  transportErrorKind,
  wireRequestCauseOf,
  maskCredentialHeaders,
  CREDENTIAL_HEADER_NAMES,
} from './contract';
export { readSseEvents, IdleTimeoutError, type SseEvent } from './sse-reader';
export { createAccumulator, type StreamAccumulator } from './stream-accumulator';
export { streamOrComplete } from './stream-fallback';
export { AnthropicProvider, type AnthropicConfig } from './anthropic';
export { OpenAiProvider, type OpenAiConfig } from './openai';
export { OpenAiResponsesProvider, type OpenAiResponsesConfig } from './openai-responses';
export {
  listAvailableModels,
  type AvailableModel,
  type ListModelsConfig,
  type ListModelsError,
} from './models';
export {
  testLlmConnection,
  type TestConnectionConfig,
  type TestConnectionResult,
  type TestConnectionError,
} from './test-connection';
export {
  chatModelsOnly,
  imageModelsOnly,
  imageSurfaceOf,
  invalidateLlmCache,
  isImageModelSettings,
  resolveAgentLlm,
  resolveImageModel,
  type ResolveLlmError,
  type ResolvedImageModel,
  type ResolvedLlm,
} from './resolve';
export {
  generateImage,
  IMAGE_SURFACES,
  type GeneratedImage,
  type ImageErrorKind,
  type ImageModelConfig,
  type ImageRequest,
  type ImageUsage,
  type ImageSurface,
} from './images';
