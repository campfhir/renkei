import { sql, type Kysely, type SqlBool } from 'kysely';
import type { DB } from '../../../db.types';
import type { ChatModelStore, EnabledModelRecord } from './types';

// The twins of @renkei/agent-llm's chatModelsOnly / imageModelsOnly.
const imageSurface = sql<SqlBool>`coalesce(settings->>'apiSurface', '') in ('images', 'flux')`;
const chatSurface = sql<SqlBool>`coalesce(settings->>'apiSurface', '') not in ('images', 'flux')`;

const COLUMNS = ['id', 'label', 'provider', 'model', 'is_default', 'settings'] as const;

function record(row: {
  id: string;
  label: string;
  provider: string;
  model: string;
  is_default: boolean;
  settings: unknown;
}): EnabledModelRecord {
  return {
    id: row.id,
    label: row.label,
    provider: row.provider,
    model: row.model,
    isDefault: row.is_default,
    settings: row.settings ?? null,
  };
}

export function postgresChatModels(db: () => Kysely<DB>): ChatModelStore {
  return {
    async listChatModels() {
      const rows = await db()
        .selectFrom('llm_model_configs')
        .select(COLUMNS)
        .where('enabled', '=', true)
        .where(chatSurface)
        .orderBy('is_default', 'desc')
        .orderBy('label', 'asc')
        .orderBy('id')
        .execute();
      return rows.map(record);
    },
    async listImageModels() {
      const rows = await db()
        .selectFrom('llm_model_configs')
        .select(COLUMNS)
        .where('enabled', '=', true)
        .where(imageSurface)
        .orderBy('label', 'asc')
        .orderBy('id')
        .execute();
      return rows.map(record);
    },
  };
}

export { record as enabledModelFromRow };
