import { orderBy, page } from '../../memory/order';
import type { MemoryTables } from '../../memory/tables';
import { phiEventFromRow, phiEventValues } from './postgres';
import type { PhiAccessStore } from './types';

export function memoryPhiAccess(tables: MemoryTables): PhiAccessStore {
  return {
    async record(event) {
      tables.insert('phi_access_events', phiEventValues(event));
    },
    async list({ subject, limit, before }) {
      const rows = tables.select(
        'phi_access_events',
        (r) =>
          (!subject || r.subject === subject) &&
          (!before || r.created_at.getTime() < before.getTime())
      );
      return page(orderBy(rows, [(r) => r.created_at, 'desc'], [(r) => r.id, 'desc']), limit).map(
        phiEventFromRow
      );
    },
  };
}
