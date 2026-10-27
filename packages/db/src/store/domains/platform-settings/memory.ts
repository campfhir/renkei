import type { MemoryTables } from '../../memory/tables';
import type { PlatformSettingStore } from './types';

export function memoryPlatformSettings(tables: MemoryTables): PlatformSettingStore {
  return {
    async get(key) {
      const row = tables.first('platform_settings', (r) => r.key === key);
      return row ? { value: row.value } : null;
    },
    async insertIfAbsent(key, value) {
      return (
        tables.upsert('platform_settings', { key, value: JSON.stringify(value) }, ['key']) !==
        undefined
      );
    },
    async update(key, value) {
      return tables.update('platform_settings', (r) => r.key === key, {
        value: JSON.stringify(value),
      }).length;
    },
  };
}
