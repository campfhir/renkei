import type { Selectable } from 'kysely';
import type { LlmModelConfigs } from '../../../db.types';
import type { LlmModelConfigInput, LlmModelConfigRecord } from './types';

export const LABEL_CONSTRAINT = 'llm_model_configs_label';

export function llmModelFromRow(row: Selectable<LlmModelConfigs>): LlmModelConfigRecord {
  return {
    id: row.id,
    label: row.label,
    provider: row.provider,
    model: row.model,
    baseUrl: row.base_url,
    settings: row.settings,
    enabled: row.enabled,
    isDefault: row.is_default,
    encryptedSecrets: row.encrypted_secrets,
  };
}

export function llmModelValues(input: LlmModelConfigInput) {
  return {
    label: input.label,
    provider: input.provider,
    model: input.model,
    base_url: input.baseUrl,
    settings: JSON.stringify(input.settings),
    encrypted_secrets: input.encryptedSecrets,
    enabled: input.enabled,
    is_default: input.isDefault,
  };
}

/** A unique violation on the label constraint, from pg or the memory tables. */
export function isLabelConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code: unknown = Reflect.get(error, 'code');
  const constraint: unknown = Reflect.get(error, 'constraint');
  const message: unknown = Reflect.get(error, 'message');
  return (
    code === '23505' &&
    (constraint === LABEL_CONSTRAINT ||
      (typeof message === 'string' && message.includes(LABEL_CONSTRAINT)))
  );
}
