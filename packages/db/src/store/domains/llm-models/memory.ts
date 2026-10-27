import { orderBy } from '../../memory/order';
import type { MemoryTables } from '../../memory/tables';
import { isLabelConflict, llmModelFromRow, llmModelValues } from './record';
import type { LlmModelStore } from './types';

export function memoryLlmModels(tables: MemoryTables): LlmModelStore {
  return {
    async list() {
      return orderBy(tables.select('llm_model_configs'), [(r) => r.label], [(r) => r.id]).map(
        llmModelFromRow
      );
    },
    async get(id) {
      const key = tables.param('llm_model_configs', 'id', id);
      const row = tables.first('llm_model_configs', (r) => r.id === key);
      return row ? llmModelFromRow(row) : null;
    },
    async create(id, input) {
      // The label check comes first, so a refused create changes nothing.
      if (tables.first('llm_model_configs', (r) => r.label === input.label)) {
        return 'duplicate-label';
      }
      // Insert first (a malformed or taken id is refused before any change),
      // then hand it the default; nothing awaits in between.
      const created = tables.insert('llm_model_configs', { id, ...llmModelValues(input) });
      if (input.isDefault) {
        tables.update('llm_model_configs', (r) => r.is_default && r.id !== created.id, {
          is_default: false,
          updated_at: new Date(),
        });
      }
      return 'created';
    },
    async update(id, input) {
      const key = tables.param('llm_model_configs', 'id', id);
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
      try {
        tables.update('llm_model_configs', (r) => r.id === key, {
          ...llmModelValues(input),
          updated_at: new Date(),
        });
      } catch (error) {
        if (isLabelConflict(error)) return 'duplicate-label';
        throw error;
      }
      return 'updated';
    },
    async delete(id) {
      const key = tables.param('llm_model_configs', 'id', id);
      return tables.delete('llm_model_configs', (r) => r.id === key).length > 0;
    },
  };
}
