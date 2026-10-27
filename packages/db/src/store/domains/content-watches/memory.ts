import { orderBy } from '../../memory/order';
import { contentWatchFromRow, REBUILD_RESET } from './record';
import type { ContentWatchStore, ContentWatchScopeCount } from './types';
import { MemoryStoreError, type MemoryTables } from '../../memory/tables';
import { metadataText } from '../knowledge-chunks/metadata-filter';

function sortedCounts(counts: Map<string | null, number>): ContentWatchScopeCount[] {
  return orderBy(
    [...counts.entries()].map(([scope, objects]) => ({ scope, objects })),
    [(row) => row.scope]
  );
}

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
    async watch(owner, { provider, scopeType, scopeKey, scopeLabel }) {
      const onScope = (r: { provider: string; scope_type: string; scope_key: string }) =>
        r.provider === provider && r.scope_type === scopeType && r.scope_key === scopeKey;
      const existing = tables.first(
        'content_watches',
        (r) => onScope(r) && r.subject === owner.subject
      );
      if (existing) {
        tables.update('content_watches', (r) => r.id === existing.id, {
          enabled: true,
          scope_label: scopeLabel,
          last_error: null,
          sync_status: 'idle',
          account_id: owner.accountId,
          updated_at: new Date(),
        });
        return { created: !existing.enabled };
      }
      const [sibling] = orderBy(
        tables.select('content_watches', (r) => onScope(r) && r.cursor !== null),
        [(r) => r.updated_at, 'desc'],
        [(r) => r.id, 'desc']
      );
      tables.insert('content_watches', {
        id: globalThis.crypto.randomUUID(),
        provider,
        account_id: owner.accountId,
        subject: owner.subject,
        scope_type: scopeType,
        scope_key: scopeKey,
        scope_label: scopeLabel,
        cursor: sibling?.cursor ?? null,
      });
      return { created: true };
    },
    async repair(owner, { provider, scopeType, scopeKey }) {
      const onScope = (r: { provider: string; scope_type: string; scope_key: string }) =>
        r.provider === provider && r.scope_type === scopeType && r.scope_key === scopeKey;
      // Every row on the scope takes the same subject, so two or more
      // collide on the unique key: Postgres refuses the whole statement,
      // and so does this, before changing any.
      if (tables.select('content_watches', onScope).length > 1) {
        throw new MemoryStoreError(
          '23505',
          'duplicate key value violates unique constraint',
          'content_watches'
        );
      }
      return tables.update('content_watches', onScope, {
        subject: owner.subject,
        account_id: owner.accountId,
        enabled: true,
        last_error: null,
        sync_status: 'idle',
        last_synced_at: null,
        updated_at: new Date(),
      }).length;
    },
    async disable(subject, { provider, scopeType, scopeKey }) {
      return tables.update(
        'content_watches',
        (r) =>
          r.provider === provider &&
          r.subject === subject &&
          r.scope_type === scopeType &&
          r.scope_key === scopeKey &&
          r.enabled,
        { enabled: false, sync_status: 'idle', updated_at: new Date() }
      ).length;
    },
    async list(subject, provider) {
      return orderBy(
        tables.select('content_watches', (r) => r.provider === provider && r.subject === subject),
        [(r) => r.scope_key],
        [(r) => r.scope_type],
        [(r) => r.id]
      ).map(contentWatchFromRow);
    },
    async objectCounts(provider, metadataKey) {
      const objects = new Map<string | null, Set<string>>();
      for (const row of tables.select('knowledge_chunks', (r) => r.provider === provider)) {
        const scope = metadataText(row.metadata, metadataKey);
        const set = objects.get(scope) ?? new Set<string>();
        set.add(row.ref_id.split('#')[0]);
        objects.set(scope, set);
      }
      const indexed = new Map<string | null, number>();
      for (const [scope, set] of objects) indexed.set(scope, set.size);

      const queued = new Map<string | null, number>();
      for (const job of tables.select('embedding_jobs', (r) => r.status === 'pending')) {
        if (metadataText(job.payload, 'provider') !== provider) continue;
        const metadata =
          typeof job.payload === 'object' && job.payload !== null && !Array.isArray(job.payload)
            ? Reflect.get(job.payload, 'metadata')
            : null;
        const scope = metadataText(metadata, metadataKey);
        queued.set(scope, (queued.get(scope) ?? 0) + 1);
      }
      return { indexed: sortedCounts(indexed), queued: sortedCounts(queued) };
    },
  };
}
