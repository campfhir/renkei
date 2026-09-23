/**
 * Wire → model-config payload, shared by the create and update admin
 * routes. Presence-only on the way out is the routes' job; this only
 * shapes what came in.
 */

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
export const API_SURFACES = ['chat_completions', 'responses'] as const;

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
    },
    apiKey: typeof payload.apiKey === 'string' && payload.apiKey ? payload.apiKey : null,
    apiKeyFromId:
      typeof payload.apiKeyFromId === 'string' && payload.apiKeyFromId
        ? payload.apiKeyFromId
        : null,
    enabled: payload.enabled !== false,
    isDefault: payload.isDefault === true,
  };
}
