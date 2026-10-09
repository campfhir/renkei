/**
 * Wire → model-config payload, shared by the create and update admin
 * routes. Presence-only on the way out is the routes' job; this only
 * shapes what came in.
 */

import { isProviderRetention, type ProviderRetention } from '@renkei/agent-llm';

export const SUPPORTED_PROVIDERS = ['anthropic', 'openai'] as const;

/**
 * Which OpenAI-compatible wire dialect a `provider: 'openai'` config
 * speaks — unlike reasoningEffort, this picks between OUR OWN two
 * adapters (openai.ts vs. openai-responses.ts), not a provider-defined
 * vocabulary, so a closed list is the right call here. 'chat_completions'
 * (the default, and every config that predates this field) covers OpenAI,
 * Azure AI Foundry's chat-completions v1 surface, and self-hosted
 * gateways; 'responses' targets the Responses API — the only surface some
 * reasoning-model deployments (a gpt-6-astra-1 case found in production)
 * accept tool calls on at all.
 */
export const API_SURFACES = ['chat_completions', 'responses', 'images', 'flux'] as const;

/**
 * The surfaces that are image generation models rather than chat ones:
 * 'images' is the OpenAI Images API (gpt-image-*), 'flux' Black Forest
 * Labs' FLUX models as Azure AI Foundry serves them. Kept in step with
 * @renkei/agent-llm's IMAGE_SURFACES.
 */
const IMAGE_API_SURFACES: readonly string[] = ['images', 'flux'];

export interface ModelPayload {
  label: string;
  provider: string;
  model: string;
  baseUrl: string | null;
  settings: {
    maxOutputTokens?: number;
    temperature?: number;
    apiVersion?: string;
    reasoningEffort?: string;
    apiSurface?: string;
    /**
     * Data handling (@renkei/agent-llm's LlmDataHandling): operator-entered,
     * stored verbatim so the roster and the PHI-connector gate read one
     * record. Absent means unknown / not covered.
     */
    dataResidency?: string;
    providerRetention?: ProviderRetention;
    baaCovered?: boolean;
    notes?: string;
  };
  apiKey: string | null;
  /**
   * Reuse the key already stored on another config row instead of typing
   * one — how several model rows share one provider connection. The routes
   * copy the encrypted blob row-to-row (same deployment key, so no decrypt
   * round-trip); an explicit apiKey outranks it.
   */
  apiKeyFromId: string | null;
  enabled: boolean;
  isDefault: boolean;
}

export function parseModelPayload(body: unknown): ModelPayload | { error: string } {
  if (typeof body !== 'object' || body === null) return { error: 'JSON body required' };
  const payload: {
    label?: unknown;
    provider?: unknown;
    model?: unknown;
    baseUrl?: unknown;
    maxOutputTokens?: unknown;
    temperature?: unknown;
    apiVersion?: unknown;
    reasoningEffort?: unknown;
    apiSurface?: unknown;
    dataResidency?: unknown;
    providerRetention?: unknown;
    baaCovered?: unknown;
    notes?: unknown;
    apiKey?: unknown;
    apiKeyFromId?: unknown;
    enabled?: unknown;
    isDefault?: unknown;
  } = body;
  if (typeof payload.label !== 'string' || !payload.label.trim()) {
    return { error: 'label is required' };
  }
  if (
    typeof payload.provider !== 'string' ||
    !SUPPORTED_PROVIDERS.some((provider) => provider === payload.provider)
  ) {
    return { error: `provider must be one of: ${SUPPORTED_PROVIDERS.join(', ')}` };
  }
  if (typeof payload.model !== 'string' || !payload.model.trim()) {
    return { error: 'model is required' };
  }
  const imageGeneration =
    typeof payload.apiSurface === 'string' && IMAGE_API_SURFACES.includes(payload.apiSurface);
  // The Images API is OpenAI's (OpenAI itself, Azure AI Foundry); there is no Anthropic one to call.
  if (imageGeneration && payload.provider !== 'openai') {
    return { error: 'An image API surface needs the openai provider (OpenAI or Azure)' };
  }
  return {
    label: payload.label.trim(),
    provider: payload.provider,
    model: payload.model.trim(),
    baseUrl:
      typeof payload.baseUrl === 'string' && payload.baseUrl.trim() ? payload.baseUrl.trim() : null,
    settings: {
      ...(typeof payload.maxOutputTokens === 'number' && payload.maxOutputTokens > 0
        ? { maxOutputTokens: Math.floor(payload.maxOutputTokens) }
        : {}),
      ...(typeof payload.temperature === 'number' ? { temperature: payload.temperature } : {}),
      ...(typeof payload.apiVersion === 'string' && payload.apiVersion.trim()
        ? { apiVersion: payload.apiVersion.trim() }
        : {}),
      // Free text, same as apiVersion below: which values a model accepts
      // for reasoning_effort is entirely the provider's call and keeps
      // growing (minimal/low/medium/high/xhigh so far, plus "none" — but
      // NOT for every model; one Azure deployment demanded "none" for tool
      // calls while another rejected "none" outright and only took
      // low/medium/high/xhigh). A fixed allowlist here was already proven
      // wrong twice; this field passes through verbatim like model id and
      // apiVersion do.
      ...(typeof payload.reasoningEffort === 'string' && payload.reasoningEffort.trim()
        ? { reasoningEffort: payload.reasoningEffort.trim() }
        : {}),
      ...(typeof payload.apiSurface === 'string' &&
      API_SURFACES.some((surface) => surface === payload.apiSurface)
        ? { apiSurface: payload.apiSurface }
        : {}),
      ...(typeof payload.dataResidency === 'string' && payload.dataResidency.trim()
        ? { dataResidency: payload.dataResidency.trim().slice(0, 200) }
        : {}),
      // A closed list, unlike reasoningEffort: these are OUR categories for
      // what a provider keeps, not a provider vocabulary. Anything else
      // reads as unknown — which is also what an unset field means.
      ...(isProviderRetention(payload.providerRetention) && payload.providerRetention !== 'unknown'
        ? { providerRetention: payload.providerRetention }
        : {}),
      ...(payload.baaCovered === true ? { baaCovered: true } : {}),
      ...(typeof payload.notes === 'string' && payload.notes.trim()
        ? { notes: payload.notes.trim().slice(0, 2_000) }
        : {}),
    },
    apiKey: typeof payload.apiKey === 'string' && payload.apiKey ? payload.apiKey : null,
    apiKeyFromId:
      typeof payload.apiKeyFromId === 'string' && payload.apiKeyFromId
        ? payload.apiKeyFromId
        : null,
    enabled: payload.enabled !== false,
    // An image model cannot answer chat, so it can never be the org's default.
    isDefault: payload.isDefault === true && !imageGeneration,
  };
}
