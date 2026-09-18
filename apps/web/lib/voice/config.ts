/**
 * The org's voice service, resolved from its `connector_configs` row the
 * way web search and embeddings are: read through the short cache, turned
 * into a typed config by @renkei/voice, null whenever it is not there, not
 * enabled, or not filled in — and null is what "voice is not available
 * here" means to every page and route.
 *
 * The voice list is cached longer (an hour) because the vendor's catalog
 * changes rarely and every chat page would otherwise ask for it: one call
 * per org per hour, whichever person opens the picker.
 */

import { parseEncryptionKey } from '@renkei/crypto';
import { readConnectorConfigCached } from '@renkei/connector-config';
import {
  VOICE_CONNECTOR,
  createVoiceProvider,
  parseVoiceConfig,
  type VoiceConfig,
  type VoiceInfo,
  type VoiceOutcome,
  type VoiceProvider,
} from '@renkei/voice';
import { logger } from '@/lib/logger';

export { VOICE_CONNECTOR };

/**
 * The org's voice configuration, or null when voice is not provisioned —
 * not configured, switched off, or missing a required field.
 */
export async function resolveVoiceConfig(tenantId: string): Promise<VoiceConfig | null> {
  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) {
    logger.error('TOKEN_ENCRYPTION_KEY is missing or malformed', {
      component: 'voice/config',
      tenantId,
    });
    return null;
  }
  const configResult = await readConnectorConfigCached(tenantId, VOICE_CONNECTOR, keyResult.val);
  if (!configResult.ok) return null;
  const config = configResult.val;
  if (!config || !config.enabled) return null;
  return parseVoiceConfig(config.settings, config.secrets);
}

export async function voiceConfigured(tenantId: string): Promise<boolean> {
  return (await resolveVoiceConfig(tenantId)) !== null;
}

/** The provider for the org, or null when voice is not provisioned. */
export async function resolveVoiceProvider(
  tenantId: string
): Promise<{ config: VoiceConfig; provider: VoiceProvider } | null> {
  const config = await resolveVoiceConfig(tenantId);
  if (!config) return null;
  return { config, provider: createVoiceProvider(config) };
}

const VOICES_CACHE_TTL_MS = 60 * 60_000;

interface VoicesCacheEntry {
  voices: VoiceInfo[];
  expiresAt: number;
  /** Which config produced the list — a changed region or key drops it. */
  fingerprint: string;
}

const voicesCache = new Map<string, VoicesCacheEntry>();

function fingerprintOf(config: VoiceConfig): string {
  return `${config.provider} ${config.region} ${config.endpoint ?? ''} ${config.apiKey.slice(-6)}`;
}

/**
 * The org's voice catalog, cached for an hour. Only a successful listing is
 * cached — a vendor outage must not be remembered as "no voices" — and a
 * failure hands back the error so the picker can say why it is empty.
 */
export async function listVoicesCached(
  tenantId: string,
  resolved: { config: VoiceConfig; provider: VoiceProvider }
): Promise<VoiceOutcome<VoiceInfo[]>> {
  const fingerprint = fingerprintOf(resolved.config);
  const cached = voicesCache.get(tenantId);
  if (cached && cached.fingerprint === fingerprint && cached.expiresAt > Date.now()) {
    return { ok: true, val: cached.voices };
  }
  const result = await resolved.provider.listVoices();
  if (result.ok) {
    voicesCache.set(tenantId, {
      voices: result.val,
      fingerprint,
      expiresAt: Date.now() + VOICES_CACHE_TTL_MS,
    });
  }
  return result;
}

/** Drop the cached voice list — after the admin form saves. */
export function invalidateVoicesCache(tenantId?: string): void {
  if (tenantId) voicesCache.delete(tenantId);
  else voicesCache.clear();
}
