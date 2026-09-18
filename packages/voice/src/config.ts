/**
 * The voice connector's configuration as the org stores it — one
 * `connector_configs` row, key `voice`, like web search and embeddings:
 * one org-wide service, one key, no per-user sign-in. Whether the row
 * exists and is enabled is what "voice is available" means everywhere in
 * the app; nothing about voice is offered to a person until it does.
 *
 * Settings (inspectable jsonb) and secrets (sealed) keys, mirrored by the
 * admin route at apps/web/app/api/admin/[slug]/connectors/voice/route.ts:
 *   settings.provider       which vendor — 'azure-speech' today
 *   settings.region         the vendor's region (Azure: `eastus`, `westeurope`…)
 *   settings.endpoint       optional custom domain / private endpoint base
 *                           URL, used instead of the regional hosts
 *   settings.defaultVoice   the voice a person hears until they pick one
 *   settings.defaultLocale  the language recognised and spoken by default
 *   secrets.apiKey          the resource's key
 *
 * Reading the row is the caller's job (apps/web owns the encryption key and
 * the cached read); this file turns whatever it read into a typed config or
 * says why it could not, and builds the provider for it.
 */

import { AzureSpeechProvider } from './azure-speech';
import type { FetchLike, VoiceProvider } from './provider';

/** The connector_configs key, and the capability key the catalog lists it under. */
export const VOICE_CONNECTOR = 'voice';

export const VOICE_PROVIDERS = ['azure-speech'] as const;
export type VoiceProviderKind = (typeof VOICE_PROVIDERS)[number];

export interface VoiceConfig {
  provider: VoiceProviderKind;
  region: string;
  /** A custom-domain or private-endpoint base URL; null for the regional hosts. */
  endpoint: string | null;
  apiKey: string;
  defaultVoice: string;
  defaultLocale: string;
}

/** What an unconfigured org falls back to when a field is blank. */
export const DEFAULT_VOICE_LOCALE = 'en-US';
export const DEFAULT_AZURE_VOICE = 'en-US-AvaMultilingualNeural';

function trimmedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isProviderKind(value: string): value is VoiceProviderKind {
  return VOICE_PROVIDERS.some((known) => known === value);
}

export function parseVoiceProviderKind(value: unknown): VoiceProviderKind | null {
  const kind = trimmedString(value);
  return kind && isProviderKind(kind) ? kind : null;
}

/** A BCP-47 tag as the vendors accept it: `en-US`, `pt-BR`, `zh-CN`. */
export function normalizeLocale(value: unknown): string | null {
  const raw = trimmedString(value);
  if (!raw) return null;
  const match = /^([A-Za-z]{2,3})[-_]([A-Za-z]{2}|\d{3})$/.exec(raw);
  if (!match) return null;
  return `${match[1].toLowerCase()}-${match[2].toUpperCase()}`;
}

/** An Azure region name: lowercase letters and digits, nothing else. */
export function normalizeRegion(value: unknown): string | null {
  const raw = trimmedString(value)?.toLowerCase() ?? null;
  return raw && /^[a-z][a-z0-9]{1,40}$/.test(raw) ? raw : null;
}

/** An https base URL with no query or fragment, trailing slash dropped. */
export function normalizeEndpoint(value: unknown): string | null {
  const raw = trimmedString(value);
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.search || url.hash) return null;
  return url.toString().replace(/\/+$/, '');
}

/**
 * The typed config out of a stored row's settings and secrets, or null when
 * a required field is missing — the caller then treats voice as not
 * configured, which is what a half-filled form should mean.
 */
export function parseVoiceConfig(
  settings: Record<string, unknown>,
  secrets: Record<string, string>
): VoiceConfig | null {
  const provider = parseVoiceProviderKind(settings.provider) ?? 'azure-speech';
  const region = normalizeRegion(settings.region);
  const endpoint = normalizeEndpoint(settings.endpoint);
  const apiKey = trimmedString(secrets.apiKey);
  if ((!region && !endpoint) || !apiKey) return null;
  return {
    provider,
    region: region ?? '',
    endpoint,
    apiKey,
    defaultVoice: trimmedString(settings.defaultVoice) ?? DEFAULT_AZURE_VOICE,
    defaultLocale: normalizeLocale(settings.defaultLocale) ?? DEFAULT_VOICE_LOCALE,
  };
}

/** The provider for a config — the one switch on vendor in the codebase. */
export function createVoiceProvider(config: VoiceConfig, fetchImpl?: FetchLike): VoiceProvider {
  switch (config.provider) {
    case 'azure-speech':
      return new AzureSpeechProvider(config, fetchImpl);
  }
}
