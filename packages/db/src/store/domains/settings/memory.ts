import { orderBy } from '../../memory/order';
import type { MemoryTables } from '../../memory/tables';
import type { SettingsStore } from './types';

export function memorySettings(tables: MemoryTables): SettingsStore {
  return {
    async all() {
      return new Map<string, unknown>(
        orderBy(tables.select('settings'), [(r) => r.key]).map((row) => [row.key, row.value])
      );
    },
    async get(key) {
      return tables.first('settings', (r) => r.key === key)?.value;
    },
    async set(key, value) {
      const json = JSON.stringify(value);
      tables.upsert('settings', { key, value: json }, ['key'], {
        value: json,
        updated_at: new Date(),
      });
    },
  };
}
