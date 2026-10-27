import type { MemoryTables } from '../../memory/tables';
import type { UserPreferenceStore } from './types';

export function memoryUserPreferences(tables: MemoryTables): UserPreferenceStore {
  return {
    async get(subject, key) {
      return tables.first('user_preferences', (r) => r.subject === subject && r.key === key)?.value;
    },
    async set(subject, key, value) {
      const json = JSON.stringify(value);
      tables.upsert('user_preferences', { subject, key, value: json }, ['subject', 'key'], {
        value: json,
        updated_at: new Date(),
      });
    },
  };
}
