import { sql, type Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import { fabricOperationFromRow } from './record';
import type { FabricOperationStore } from './types';

const json = (value: unknown): string | null =>
  value === null || value === undefined ? null : JSON.stringify(value);

export function postgresFabricOperations(db: () => Kysely<DB>): FabricOperationStore {
  return {
    async insert(operation) {
      const row = await db()
        .insertInto('fabric_operations')
        .values({
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
          result: json(operation.result),
          error: operation.error,
          next_poll_at: operation.nextPollAt,
          finished_at: operation.finishedAt,
          created_at: operation.createdAt,
          updated_at: operation.createdAt,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return fabricOperationFromRow(row);
    },

    async find(subject, id) {
      const row = await db()
        .selectFrom('fabric_operations')
        .selectAll()
        .where('id', '=', id)
        .where('subject', '=', subject)
        .executeTakeFirst();
      return row ? fabricOperationFromRow(row) : null;
    },

    async list(subject, { limit }) {
      const rows = await db()
        .selectFrom('fabric_operations')
        .selectAll()
        .where('subject', '=', subject)
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(limit)
        .execute();
      return rows.map(fabricOperationFromRow);
    },

    async claim(id, now, leaseUntil) {
      const row = await db()
        .updateTable('fabric_operations')
        .set({ next_poll_at: leaseUntil })
        .where('id', '=', id)
        .where('status', '=', 'running')
        .where((eb) => eb.or([eb('next_poll_at', 'is', null), eb('next_poll_at', '<=', now)]))
        .returningAll()
        .executeTakeFirst();
      return row ? fabricOperationFromRow(row) : null;
    },

    async claimDue({ now, leaseUntil, unwatchedSince, limit }) {
      const rows = await db()
        .updateTable('fabric_operations')
        .set({ next_poll_at: leaseUntil })
        .where(
          'id',
          'in',
          db()
            .selectFrom('fabric_operations')
            .select('id')
            .where('status', '=', 'running')
            .where((eb) => eb.or([eb('next_poll_at', 'is', null), eb('next_poll_at', '<=', now)]))
            .where((eb) =>
              eb.or([eb('watched_at', 'is', null), eb('watched_at', '<', unwatchedSince)])
            )
            .orderBy('next_poll_at', (ob) => ob.asc().nullsFirst())
            .orderBy('id')
            .limit(limit)
            .forUpdate()
            .skipLocked()
        )
        .returningAll()
        .execute();
      return rows.map(fabricOperationFromRow).sort((a, b) => (a.id < b.id ? -1 : 1));
    },

    async progress(id, patch, at) {
      const row = await db()
        .updateTable('fabric_operations')
        .set({
          percent_complete: patch.percentComplete,
          next_poll_at: patch.nextPollAt,
          ...(patch.operationId !== undefined ? { operation_id: patch.operationId } : {}),
          updated_at: at,
        })
        .where('id', '=', id)
        .where('status', '=', 'running')
        .returningAll()
        .executeTakeFirst();
      return row ? fabricOperationFromRow(row) : null;
    },

    async finish(id, outcome, at) {
      const row = await db()
        .updateTable('fabric_operations')
        .set({
          status: outcome.status,
          result: json(outcome.result),
          error: outcome.error,
          percent_complete: outcome.status === 'succeeded' ? 100 : sql`percent_complete`,
          next_poll_at: null,
          updated_at: at,
          finished_at: at,
        })
        .where('id', '=', id)
        .where('status', '=', 'running')
        .returningAll()
        .executeTakeFirst();
      return row ? fabricOperationFromRow(row) : null;
    },

    async markWatched(subject, id, at) {
      await db()
        .updateTable('fabric_operations')
        .set({ watched_at: at })
        .where('id', '=', id)
        .where('subject', '=', subject)
        .execute();
    },

    async markNotified(id, at) {
      const result = await db()
        .updateTable('fabric_operations')
        .set({ notified_at: at })
        .where('id', '=', id)
        .where('notified_at', 'is', null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    },

    async deleteFinishedBefore(before) {
      const result = await db()
        .deleteFrom('fabric_operations')
        .where('status', '<>', 'running')
        .where('finished_at', '<', before)
        .executeTakeFirst();
      return Number(result.numDeletedRows);
    },
  };
}
