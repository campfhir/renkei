import { orderBy } from '../../memory/order';
import { toJson, type MemoryTables } from '../../memory/tables';
import { isImageSurface, llmModelFromRow, llmModelValues } from './record';
import type { LlmModelStore } from './types';

export function memoryLlmModels(tables: MemoryTables): LlmModelStore {
  return {
    async list() {
      return orderBy(tables.select('llm_model_configs'), [(r) => r.label], [(r) => r.id]).map(
        llmModelFromRow
      );
    },
    async findEnabledChatModel(id) {
      const key = id ? id : null;
      const rows = tables.select(
        'llm_model_configs',
        (r) =>
          r.enabled && !isImageSurface(r.settings) && (key === null ? r.is_default : r.id === key)
      );
      const row = orderBy(rows, [(r) => r.id])[0];
      return row ? llmModelFromRow(row) : null;
    },
    async findEnabledImageModel(id) {
      const key = id ? id : null;
      const rows = tables.select(
        'llm_model_configs',
        (r) => r.enabled && isImageSurface(r.settings) && (key === null || r.id === key)
      );
      const row = orderBy(rows, [(r) => r.label], [(r) => r.id])[0];
      return row ? llmModelFromRow(row) : null;
    },
    async get(id) {
      const key = id;
      const row = tables.first('llm_model_configs', (r) => r.id === key);
      return row ? llmModelFromRow(row) : null;
    },
    async create(id, input) {
      // The label check comes first, so a refused create changes nothing.
      if (tables.first('llm_model_configs', (r) => r.label === input.label)) {
        return 'duplicate-label';
      }
      const now = new Date();
      const created = tables.insert('llm_model_configs', {
        id,
        ...llmModelValues(input),
        settings: toJson(input.settings),
        created_at: now,
        updated_at: now,
      });
      if (input.isDefault) {
        tables.update('llm_model_configs', (r) => r.is_default && r.id !== created.id, {
          is_default: false,
          updated_at: new Date(),
        });
      }
      return 'created';
    },
    async update(id, input) {
      const key = id;
      if (!tables.first('llm_model_configs', (r) => r.id === key)) return 'not-found';
      if (tables.first('llm_model_configs', (r) => r.label === input.label && r.id !== key)) {
        return 'duplicate-label';
      }
      if (input.isDefault) {
        tables.update('llm_model_configs', (r) => r.is_default && r.id !== key, {
          is_default: false,
          updated_at: new Date(),
        });
      }
      tables.update('llm_model_configs', (r) => r.id === key, {
        ...llmModelValues(input),
        settings: toJson(input.settings),
        updated_at: new Date(),
      });
      return 'updated';
    },
    async delete(id) {
      const key = id;
      const deleted = tables.delete('llm_model_configs', (r) => r.id === key).length > 0;
      // Whatever named the model falls back to the default.
      for (const table of ['agents', 'chats', 'chat_turns', 'chat_messages'] as const) {
        tables.updateWhere(table, (r) => r.llm_model_id === key, { llm_model_id: null });
      }
      return deleted;
    },
  };
}
