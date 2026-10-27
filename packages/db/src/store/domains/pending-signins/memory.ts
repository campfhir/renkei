import { orderBy } from '../../memory/order';
import type { MemoryTables } from '../../memory/tables';
import { pendingSigninFromRow, pendingSigninValues } from './record';
import type { PendingSigninStore } from './types';

export function memoryPendingSignins(tables: MemoryTables): PendingSigninStore {
  return {
    async create(pending) {
      tables.insert('pending_oidc_signin', pendingSigninValues(pending));
    },
    async findByState(state) {
      const [row] = orderBy(
        tables.select('pending_oidc_signin', (r) => r.state === state),
        [(r) => r.id]
      );
      return row ? pendingSigninFromRow(row) : null;
    },
    async deleteByState(state) {
      return tables.delete('pending_oidc_signin', (r) => r.state === state).length;
    },
  };
}
