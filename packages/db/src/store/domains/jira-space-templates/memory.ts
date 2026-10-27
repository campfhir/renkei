import { orderBy, page } from '../../memory/order';
import type { MemoryTables } from '../../memory/tables';
import { JIRA_SPACE_TEMPLATES as TABLE, templateFromRow, templateValues } from './record';
import type { JiraSpaceTemplateStore } from './types';

export function memoryJiraSpaceTemplates(tables: MemoryTables): JiraSpaceTemplateStore {
  return {
    async save(input, { overwrite }) {
      const values = templateValues(input);
      const row = tables.upsert(
        TABLE,
        values,
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
      const key = 'id' in reference ? tables.param(TABLE, 'id', reference.id) : null;
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
      const key = tables.param(TABLE, 'id', id);
      return tables.delete(TABLE, (r) => r.id === key).length > 0;
    },
  };
}
