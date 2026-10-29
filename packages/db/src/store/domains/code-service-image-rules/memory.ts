import { orderBy } from '../../memory/order';
import { uniqueViolation, type MemoryTables } from '../../memory/tables';
import { imageRuleFromRow, imageRuleMatchFromRow, imageRulePatch, imageRuleValues } from './record';
import type { CodeServiceImageRuleStore } from './types';

export function memoryCodeServiceImageRules(tables: MemoryTables): CodeServiceImageRuleStore {
  const byPattern = () => orderBy(tables.select('code_service_image_rules'), [(r) => r.pattern]);
  // The sandbox worker answers a taken pattern with its own "already exists".
  const refuseTakenPattern = (pattern: string, except?: string) => {
    if (tables.first('code_service_image_rules', (r) => r.pattern === pattern && r.id !== except)) {
      throw uniqueViolation('code_service_image_rules', 'idx_code_service_image_rules_pattern');
    }
  };
  const blank = () => {
    const now = new Date();
    return { id: globalThis.crypto.randomUUID(), created_at: now, updated_at: now };
  };
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
      refuseTakenPattern(rule.pattern);
      return imageRuleFromRow(
        tables.insert('code_service_image_rules', { ...blank(), ...imageRuleValues(rule) })
      );
    },
    async update(rule) {
      const wanted = rule.id;
      refuseTakenPattern(rule.pattern, wanted);
      const [row] = tables.update(
        'code_service_image_rules',
        (r) => r.id === wanted,
        imageRulePatch(rule)
      );
      return row ? imageRuleFromRow(row) : null;
    },
    async delete(ruleId) {
      const wanted = ruleId;
      return tables.delete('code_service_image_rules', (r) => r.id === wanted).length > 0;
    },
    async insertMissing(rules) {
      let added = 0;
      for (const rule of rules) {
        const row = tables.upsert(
          'code_service_image_rules',
          {
            ...blank(),
            pattern: rule.pattern,
            note: rule.note,
            registry_username: null,
            registry_sealed: null,
          },
          ['pattern']
        );
        if (row) added += 1;
      }
      return added;
    },
  };
}
