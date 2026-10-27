import { orderBy } from '../../memory/order';
import type { MemoryTables } from '../../memory/tables';
import { contentWatchFromRow, REBUILD_RESET } from './record';
import type { ContentWatchStore } from './types';

export function memoryContentWatches(tables: MemoryTables): ContentWatchStore {
  return {
    async listForSubject(subject) {
      const rows = tables.select('content_watches', (r) => r.subject === subject);
      return orderBy(rows, [(r) => r.scope_key], [(r) => r.provider], [(r) => r.id]).map(
        contentWatchFromRow
      );
    },
    async findForSubject(subject, provider, scopeKey) {
      const rows = tables.select(
        'content_watches',
        (r) => r.subject === subject && r.provider === provider && r.scope_key === scopeKey
      );
      const row = orderBy(rows, [(r) => r.created_at], [(r) => r.id])[0];
      return row ? contentWatchFromRow(row) : null;
    },
    async resetForRebuild(id) {
      const wanted = tables.param('content_watches', 'id', id);
      return tables.update('content_watches', (r) => r.id === wanted, {
        ...REBUILD_RESET,
        updated_at: new Date(),
      }).length;
    },
  };
}
