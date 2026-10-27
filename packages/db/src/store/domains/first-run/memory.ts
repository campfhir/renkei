import type { MemoryTables } from '../../memory/tables';
import type { FirstRunStore } from './types';

export function memoryFirstRun(tables: MemoryTables): FirstRunStore {
  return {
    async identityProviderConfigured() {
      return tables.select('oidc_config').length > 0;
    },
  };
}
