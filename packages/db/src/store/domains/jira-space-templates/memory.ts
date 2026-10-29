import { orderBy, page } from '../../memory/order';
import { toJson, type MemoryTables } from '../../memory/tables';
import { JIRA_SPACE_TEMPLATES as TABLE, templateFromRow, templateValues } from './record';
import type { JiraSpaceTemplateStore } from './types';

export function memoryJiraSpaceTemplates(tables: MemoryTables): JiraSpaceTemplateStore {
  return {
    async save(input, { overwrite }) {
      const values = { ...templateValues(input), document: toJson(input.document) };
      const now = new Date();
      const row = tables.upsert(
        TABLE,
        { ...values, id: globalThis.crypto.randomUUID(), created_at: now, updated_at: now },
        ['cloud_id', 'name_key'],
        overwrite
          ? {
              name: values.name,
              description: values.description,
              source_space_key: values.source_space_key,
              site_url: values.site_url,
              document: values.document,
              updated_by: input.subject,
              updated_at: new Date(),
            }
          : undefined
      );
      return row ? templateFromRow(row) : null;
    },
    async find(cloudId, reference) {
      const key = 'id' in reference ? reference.id : null;
      const rows = tables.select(TABLE, (r) =>
        'id' in reference ? r.id === key : r.name_key === reference.nameKey
      );
      return orderBy(rows, [(r) => r.cloud_id === cloudId, 'desc'], [(r) => r.id]).map(
        templateFromRow
      );
    },
    async list(limit) {
      const rows = tables.select(TABLE);
      return page(orderBy(rows, [(r) => r.name_key], [(r) => r.id]), limit).map(templateFromRow);
    },
    async delete(id) {
      const key = id;
      return tables.delete(TABLE, (r) => r.id === key).length > 0;
    },
  };
}
