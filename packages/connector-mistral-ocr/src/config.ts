/**
 * Per-tenant configuration for the Mistral OCR connector — same shape as
 * every other service-credential connector here (connector_configs:
 * `settings` for the inspectable endpoint/model, `encrypted_secrets` for
 * the API key). Unlike OnBase, there is no per-user OAuth: one org-wide
 * key authorizes every call, so a single resolve function is the whole
 * auth story for both the ad-hoc sandbox_ocr_file tool (apps/web) and the
 * document-ocr-pipeline batch handler (apps/worker) — both import this
 * directly rather than each re-deriving it.
 */

import { parseEncryptionKey } from '@renkei/crypto';
import { readConnectorConfigCached } from '@renkei/connector-config';
import type { MistralOcrConfig } from './types';

export const MISTRAL_OCR_CONNECTOR = 'mistral-ocr';

/** The model/deployment name Microsoft's Foundry blog names as the OCR 4 catalog entry. */
export const DEFAULT_MISTRAL_OCR_MODEL = 'mistral-ocr-4-0';

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export type ResolveMistralOcrError = 'unconfigured' | 'db_error';

export async function resolveMistralOcrConfig(
  tenantId: string
): Promise<{ ok: true; val: MistralOcrConfig } | { ok: false; err: ResolveMistralOcrError }> {
  const key = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!key.ok) return { ok: false, err: 'unconfigured' };

  const configResult = await readConnectorConfigCached(tenantId, MISTRAL_OCR_CONNECTOR, key.val);
  if (!configResult.ok) return { ok: false, err: 'db_error' };

  const config = configResult.val;
  if (!config || !config.enabled) return { ok: false, err: 'unconfigured' };

  const endpoint = str(config.settings.endpoint);
  const apiKey = config.secrets.apiKey;
  if (!endpoint || !apiKey) return { ok: false, err: 'unconfigured' };

  return {
    ok: true,
    val: { endpoint, apiKey, model: str(config.settings.model) || DEFAULT_MISTRAL_OCR_MODEL },
  };
}
