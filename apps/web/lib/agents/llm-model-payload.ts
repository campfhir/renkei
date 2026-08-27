/**
 * Wire → model-config payload, shared by the create and update admin
 * routes. Presence-only on the way out is the routes' job; this only
 * shapes what came in.
 */

export const SUPPORTED_PROVIDERS = ['anthropic', 'openai'] as const;

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
      ...(typeof payload.reasoningEffort === 'string' &&
      ['minimal', 'low', 'medium', 'high'].includes(payload.reasoningEffort)
        ? { reasoningEffort: payload.reasoningEffort }
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
