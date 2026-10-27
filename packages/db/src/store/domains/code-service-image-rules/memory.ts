import { orderBy } from '../../memory/order';
import type { MemoryTables } from '../../memory/tables';
import { imageRuleFromRow, imageRuleMatchFromRow, imageRulePatch, imageRuleValues } from './record';
import type { CodeServiceImageRuleStore } from './types';

export function memoryCodeServiceImageRules(tables: MemoryTables): CodeServiceImageRuleStore {
  const id = (value: string) => tables.param('code_service_image_rules', 'id', value);
  const byPattern = () => orderBy(tables.select('code_service_image_rules'), [(r) => r.pattern]);
  return {
    async list() {
      return byPattern().map(imageRuleFromRow);
    },
    async count() {
      return tables.select('code_service_image_rules').length;
    },
    async listForMatching() {
      return byPattern().map(imageRuleMatchFromRow);
    },
    async insert(rule) {
      return imageRuleFromRow(tables.insert('code_service_image_rules', imageRuleValues(rule)));
    },
    async update(rule) {
      const wanted = id(rule.id);
      const [row] = tables.update(
        'code_service_image_rules',
        (r) => r.id === wanted,
        imageRulePatch(rule)
      );
      return row ? imageRuleFromRow(row) : null;
    },
    async delete(ruleId) {
      const wanted = id(ruleId);
      return tables.delete('code_service_image_rules', (r) => r.id === wanted).length > 0;
    },
    async insertMissing(rules) {
      let added = 0;
      for (const rule of rules) {
        const row = tables.upsert(
          'code_service_image_rules',
          { pattern: rule.pattern, note: rule.note },
          ['pattern']
        );
        if (row) added += 1;
      }
      return added;
    },
  };
}
