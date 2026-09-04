/**
 * The org's model roster as the composer's picker sees it: enabled rows
 * only, the default flagged, and whether the model takes a thinking
 * budget. Keys never leave the database.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import type { ModelOption } from './views';

export async function listChatModels(db: Kysely<DB>, tenantId: string): Promise<ModelOption[]> {
  const rows = await db
    .selectFrom('llm_model_configs')
    .select(['id', 'label', 'provider', 'model', 'is_default'])
    .where('tenant_id', '=', tenantId)
    .where('enabled', '=', true)
    .orderBy('is_default', 'desc')
    .orderBy('label', 'asc')
    .execute();
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    provider: row.provider,
    model: row.model,
    isDefault: row.is_default,
    supportsThinking: row.provider === 'anthropic',
  }));
}
