/**
 * Which model runs an agent, and with whose key.
 *
 * Resolution order: the agent's own override (if set AND still enabled),
 * else the org's default row. No configured model is a typed `NO_MODEL` —
 * the engine fails the run as configuration before spending anything.
 *
 * Secrets decrypt with the deployment key (TOKEN_ENCRYPTION_KEY) at the
 * moment of use and live only in the returned provider instance. A short
 * cache (the readConnectorConfigCached pattern) keeps the per-run cost at
 * one lookup without letting an admin's key rotation take longer than a
 * minute to bite.
 */

import { sql, type Kysely, type SqlBool } from 'kysely';
import type { DB } from '@renkei/db';
import { decrypt, parseEncryptionKey } from '@renkei/crypto';
import { ok, err, wrapAsync } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import type { LlmProvider } from './contract';
import { IMAGE_SURFACES, type ImageModelConfig, type ImageSurface } from './images';
import { AnthropicProvider } from './anthropic';
import { OpenAiProvider } from './openai';
import { OpenAiResponsesProvider } from './openai-responses';

export interface ResolvedLlm {
  provider: LlmProvider;
  /** The llm_model_configs row that answered, recorded on run history. */
  modelConfigId: string;
  providerName: string;
  model: string;
  maxOutputTokens: number;
  temperature?: number;
}

export type ResolveLlmError = 'NO_MODEL' | 'UNSUPPORTED_PROVIDER' | 'CONFIG_ERROR' | 'DB_ERROR';

/**
 * A model row whose API surface is an image one (settings.apiSurface
 * 'images' — the OpenAI Images API — or 'flux'): an image generation
 * model such as gpt-image-1 or FLUX.2-flex. It is not a chat model, so it
 * must never be offered where a chat model is chosen — the picker, the
 * org default, an agent's override, a sub-agent's roster.
 */
export function imageSurfaceOf(settings: unknown): ImageSurface | null {
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) return null;
  const surface: unknown = Reflect.get(settings, 'apiSurface');
  return IMAGE_SURFACES.find((candidate) => candidate === surface) ?? null;
}

export function isImageModelSettings(settings: unknown): boolean {
  return imageSurfaceOf(settings) !== null;
}

/** `.where(chatModelsOnly)` — the SQL twin of !isImageModelSettings, for every query that picks a chat model. */
export const chatModelsOnly = sql<SqlBool>`coalesce(settings->>'apiSurface', '') not in ('images', 'flux')`;

/** `.where(imageModelsOnly)` — the rows that generate images. */
export const imageModelsOnly = sql<SqlBool>`coalesce(settings->>'apiSurface', '') in ('images', 'flux')`;

const CACHE_TTL_MS = 60_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 4_096;

interface CacheEntry {
  value: ResolvedLlm;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Test hook, and the admin routes' invalidation on config writes. */
export function invalidateLlmCache(tenantId?: string): void {
  if (tenantId === undefined) {
    cache.clear();
    return;
  }
  for (const key of cache.keys()) {
    if (key.startsWith(`${tenantId}:`)) cache.delete(key);
  }
}

interface ModelRow {
  id: string;
  provider: string;
  model: string;
  base_url: string | null;
  settings: unknown;
  encrypted_secrets: string | null;
}

function settingsOf(row: ModelRow): { maxOutputTokens: number; temperature?: number } {
  const settings: { maxOutputTokens?: unknown; temperature?: unknown } =
    typeof row.settings === 'object' && row.settings !== null && !Array.isArray(row.settings)
      ? row.settings
      : {};
  return {
    maxOutputTokens:
      typeof settings.maxOutputTokens === 'number' && settings.maxOutputTokens > 0
        ? Math.floor(settings.maxOutputTokens)
        : DEFAULT_MAX_OUTPUT_TOKENS,
    ...(typeof settings.temperature === 'number' ? { temperature: settings.temperature } : {}),
  };
}

/** The optional string knobs stored in settings jsonb; blank = absent. */
function settingString(
  row: ModelRow,
  key: 'apiVersion' | 'reasoningEffort' | 'apiSurface'
): string | null {
  const settings: { apiVersion?: unknown; reasoningEffort?: unknown; apiSurface?: unknown } =
    typeof row.settings === 'object' && row.settings !== null && !Array.isArray(row.settings)
      ? row.settings
      : {};
  const value = settings[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function buildProvider(row: ModelRow, apiKey: string): Result<LlmProvider, ResolveLlmError> {
  const shared = {
    apiKey,
    model: row.model,
    baseUrl: row.base_url,
    apiVersion: settingString(row, 'apiVersion'),
    reasoningEffort: settingString(row, 'reasoningEffort'),
  };
  switch (row.provider) {
    case 'anthropic':
      return ok(new AnthropicProvider(shared));
    // The OpenAI-spec dialect covers OpenAI, Azure AI Foundry's v1 surface,
    // and self-hosted gateways — one adapter, distinguished by base_url.
    // 'responses' opts a config into the Responses API adapter instead —
    // some reasoning-model deployments (a gpt-6-astra-1 case discovered in
    // production) cannot do function/tool calling on chat-completions at
    // ANY reasoning_effort value and require it. Every existing config
    // predates this setting and keeps the chat-completions default.
    case 'openai':
      return ok(
        settingString(row, 'apiSurface') === 'responses'
          ? new OpenAiResponsesProvider(shared)
          : new OpenAiProvider(shared)
      );
    // 'gemini' slots in here.
    default:
      return err('UNSUPPORTED_PROVIDER' as const, {
        message: `No adapter for provider "${row.provider}"`,
      });
  }
}

/** The row's API key, decrypted with the deployment key at the moment of use. */
function apiKeyOf(row: ModelRow): Result<string, ResolveLlmError> {
  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) return err('CONFIG_ERROR' as const, { message: 'Encryption key missing' });

  if (!row.encrypted_secrets) {
    return err('CONFIG_ERROR' as const, { message: 'The model has no API key stored.' });
  }
  const secretsResult = decrypt(row.encrypted_secrets, keyResult.val);
  if (!secretsResult.ok) {
    return err('CONFIG_ERROR' as const, { message: 'The stored API key cannot be decrypted.' });
  }
  let apiKey = '';
  try {
    const secrets: { apiKey?: unknown } = JSON.parse(secretsResult.val);
    if (typeof secrets.apiKey === 'string') apiKey = secrets.apiKey;
  } catch {
    return err('CONFIG_ERROR' as const, { message: 'The stored secrets are malformed.' });
  }
  if (!apiKey) return err('CONFIG_ERROR' as const, { message: 'The model has no API key stored.' });
  return ok(apiKey);
}

export async function resolveAgentLlm(
  db: Kysely<DB>,
  tenantId: string,
  agentModelConfigId: string | null
): Promise<Result<ResolvedLlm, ResolveLlmError>> {
  const cacheKey = `${tenantId}:${agentModelConfigId ?? 'default'}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return ok(cached.value);

  const rowResult = await wrapAsync(async () => {
    let query = db
      .selectFrom('llm_model_configs')
      .select(['id', 'provider', 'model', 'base_url', 'settings', 'encrypted_secrets'])
      .where('tenant_id', '=', tenantId)
      .where('enabled', '=', true)
      .where(chatModelsOnly);
    query = agentModelConfigId
      ? query.where('id', '=', agentModelConfigId)
      : query.where('is_default', '=', sql<boolean>`true`);
    return query.executeTakeFirst();
  }, 'DB_ERROR' as const);
  if (!rowResult.ok) return rowResult;

  // An override that no longer resolves falls back to the org default —
  // the agent should degrade to the org's model, not to nothing.
  if (!rowResult.val && agentModelConfigId) {
    return resolveAgentLlm(db, tenantId, null);
  }
  const row = rowResult.val;
  if (!row) {
    return err('NO_MODEL' as const, {
      message: 'No model is configured for this organization.',
    });
  }

  const key = apiKeyOf(row);
  if (!key.ok) return key;
  const apiKey = key.val;

  const providerResult = buildProvider(row, apiKey);
  if (!providerResult.ok) return providerResult;

  const resolved: ResolvedLlm = {
    provider: providerResult.val,
    modelConfigId: row.id,
    providerName: row.provider,
    model: row.model,
    ...settingsOf(row),
  };
  cache.set(cacheKey, { value: resolved, expiresAt: Date.now() + CACHE_TTL_MS });
  return ok(resolved);
}

export interface ResolvedImageModel {
  modelConfigId: string;
  label: string;
  /** What the Images API call needs; the key lives only in this object. */
  config: ImageModelConfig;
}

/**
 * The enabled image generation model `modelConfigId`, or — with null —
 * the first one the org has. Never a chat model: a row is an image model
 * only when its API surface is an image one.
 */
/** `settings.fluxOptions` — BFL's advanced knobs; ranges are enforced where they are sent. */
function fluxOptionsOf(row: ModelRow): ImageModelConfig['fluxOptions'] {
  const settings: { fluxOptions?: unknown } =
    typeof row.settings === 'object' && row.settings !== null && !Array.isArray(row.settings)
      ? row.settings
      : {};
  const raw = settings.fluxOptions;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const pick = (key: string): number | undefined => {
    const value: unknown = Reflect.get(raw, key);
    return typeof value === 'number' ? value : undefined;
  };
  const upsampling: unknown = Reflect.get(raw, 'promptUpsampling');
  return {
    steps: pick('steps'),
    guidance: pick('guidance'),
    safetyTolerance: pick('safetyTolerance'),
    ...(typeof upsampling === 'boolean' ? { promptUpsampling: upsampling } : {}),
  };
}

export async function resolveImageModel(
  db: Kysely<DB>,
  tenantId: string,
  modelConfigId: string | null
): Promise<Result<ResolvedImageModel, ResolveLlmError>> {
  const rowResult = await wrapAsync(async () => {
    let query = db
      .selectFrom('llm_model_configs')
      .select(['id', 'label', 'provider', 'model', 'base_url', 'settings', 'encrypted_secrets'])
      .where('tenant_id', '=', tenantId)
      .where('enabled', '=', true)
      .where(imageModelsOnly);
    if (modelConfigId) query = query.where('id', '=', modelConfigId);
    return query.orderBy('label', 'asc').executeTakeFirst();
  }, 'DB_ERROR' as const);
  if (!rowResult.ok) return rowResult;
  const row = rowResult.val;
  if (!row) {
    return err('NO_MODEL' as const, { message: 'No image generation model is configured.' });
  }
  // Both image surfaces are OpenAI-dialect (OpenAI itself, Azure AI Foundry); Anthropic has no image API.
  if (row.provider !== 'openai') {
    return err('UNSUPPORTED_PROVIDER' as const, {
      message: `No image adapter for provider "${row.provider}"`,
    });
  }
  const key = apiKeyOf(row);
  if (!key.ok) return key;
  return ok({
    modelConfigId: row.id,
    label: row.label,
    config: {
      apiKey: key.val,
      model: row.model,
      surface: imageSurfaceOf(row.settings) ?? 'images',
      baseUrl: row.base_url,
      apiVersion: settingString(row, 'apiVersion'),
      fluxOptions: fluxOptionsOf(row),
    },
  });
}
