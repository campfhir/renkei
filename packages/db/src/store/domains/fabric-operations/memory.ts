import type { MemoryTables } from '../../memory/tables';
import { toJson } from '../../memory/tables';
import { orderBy } from '../../memory/order';
import { fabricOperationFromRow } from './record';
import type { FabricOperationStore } from './types';

const due = (next: Date | null, now: Date): boolean => !next || next.getTime() <= now.getTime();

export function memoryFabricOperations(tables: MemoryTables): FabricOperationStore {
  return {
    async insert(operation) {
      const row = tables.insert('fabric_operations', {
        id: operation.id,
        subject: operation.subject,
        kind: operation.kind,
        workspace_id: operation.workspaceId,
        workspace_name: operation.workspaceName,
        item_id: operation.itemId,
        item_name: operation.itemName,
        format: operation.format,
        status: operation.status,
        operation_id: operation.operationId,
        percent_complete: operation.percentComplete,
        result: operation.result === null ? null : toJson(operation.result),
        error: operation.error,
        next_poll_at: operation.nextPollAt,
        watched_at: null,
        notified_at: null,
        created_at: operation.createdAt,
        updated_at: operation.createdAt,
        finished_at: operation.finishedAt,
      });
      return fabricOperationFromRow(row);
    },

    async find(subject, id) {
      const row = tables.first('fabric_operations', (r) => r.id === id && r.subject === subject);
      return row ? fabricOperationFromRow(row) : null;
    },

    async list(subject, { limit }) {
      const rows = orderBy(
        tables.select('fabric_operations', (r) => r.subject === subject),
        [(r) => r.created_at, 'desc'],
        [(r) => r.id, 'desc']
      );
      return rows.slice(0, limit).map(fabricOperationFromRow);
    },

    async claim(id, now, leaseUntil) {
      const [row] = tables.update(
        'fabric_operations',
        (r) => r.id === id && r.status === 'running' && due(r.next_poll_at, now),
        { next_poll_at: leaseUntil }
      );
      return row ? fabricOperationFromRow(row) : null;
    },

    async claimDue({ now, leaseUntil, unwatchedSince, limit }) {
      const candidates = orderBy(
        tables.select(
          'fabric_operations',
          (r) =>
            r.status === 'running' &&
            due(r.next_poll_at, now) &&
            (!r.watched_at || r.watched_at.getTime() < unwatchedSince.getTime())
        ),
        // ASC NULLS FIRST, as the Postgres side asks.
        [(r) => (r.next_poll_at ? r.next_poll_at.getTime() : -Infinity)],
        [(r) => r.id]
      ).slice(0, limit);
      const ids = new Set(candidates.map((r) => r.id));
      const rows = tables.update('fabric_operations', (r) => ids.has(r.id), {
        next_poll_at: leaseUntil,
      });
      return orderBy(rows, [(r) => r.id]).map(fabricOperationFromRow);
    },

    async progress(id, patch, at) {
      const [row] = tables.update(
        'fabric_operations',
        (r) => r.id === id && r.status === 'running',
        {
          percent_complete: patch.percentComplete,
          next_poll_at: patch.nextPollAt,
          ...(patch.operationId !== undefined ? { operation_id: patch.operationId } : {}),
          updated_at: at,
        }
      );
      return row ? fabricOperationFromRow(row) : null;
    },

    async finish(id, outcome, at) {
      const [row] = tables.update(
        'fabric_operations',
        (r) => r.id === id && r.status === 'running',
        (r) => ({
          status: outcome.status,
          result: outcome.result === null ? null : toJson(outcome.result),
          error: outcome.error,
          percent_complete: outcome.status === 'succeeded' ? 100 : r.percent_complete,
          next_poll_at: null,
          updated_at: at,
          finished_at: at,
        })
      );
      return row ? fabricOperationFromRow(row) : null;
    },

    async markWatched(subject, id, at) {
      tables.update('fabric_operations', (r) => r.id === id && r.subject === subject, {
        watched_at: at,
      });
    },

    async markNotified(id, at) {
      return (
        tables.update('fabric_operations', (r) => r.id === id && r.notified_at === null, {
          notified_at: at,
        }).length > 0
      );
    },

    async deleteFinishedBefore(before) {
      return tables.delete(
        'fabric_operations',
        (r) =>
          r.status !== 'running' &&
          r.finished_at !== null &&
          r.finished_at.getTime() < before.getTime()
      ).length;
    },
  };
}
