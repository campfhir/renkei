import { orderBy } from '../../memory/order';
import { toJson, type MemoryTables } from '../../memory/tables';
import type { UserPreferenceStore } from './types';

export function memoryUserPreferences(tables: MemoryTables): UserPreferenceStore {
  return {
    async get(subject, key) {
      return tables.first('user_preferences', (r) => r.subject === subject && r.key === key)?.value;
    },
    async set(subject, key, value) {
      const json = toJson(value);
      tables.upsert(
        'user_preferences',
        { subject, key, value: json, updated_at: new Date() },
        ['subject', 'key'],
        {
          value: json,
          updated_at: new Date(),
        }
      );
    },
    async delete(subject, key) {
      tables.delete('user_preferences', (r) => r.subject === subject && r.key === key);
    },
    async listByKey(key) {
      return orderBy(
        tables.select('user_preferences', (r) => r.key === key),
        [(r) => r.subject]
      ).map((row) => ({ subject: row.subject, value: row.value }));
    },
  };
}
