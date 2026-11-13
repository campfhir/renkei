import type { Kysely, Selectable } from 'kysely';
import type { DB, Sandboxes } from '../../../db.types';
import type { SandboxKind, SandboxRecord, SandboxState, SandboxStore } from './types';

function recordOf(row: Selectable<Sandboxes>): SandboxRecord {
  return {
    id: row.id,
    routeKey: row.route_key,
    // The table's CHECK constraints admit exactly these.
    kind: row.kind as SandboxKind,
    provider: row.provider,
    providerId: row.provider_id,
    state: row.state as SandboxState,
    address: row.address,
    error: row.error,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
    stateChangedAt: row.state_changed_at,
    verifiedAt: row.verified_at,
  };
}

export function postgresSandboxes(db: () => Kysely<DB>): SandboxStore {
  return {
    async claim(input) {
      const row = await db()
        .insertInto('sandboxes')
        .values({
          id: input.id,
          route_key: input.routeKey,
          kind: input.kind,
          provider: input.provider,
          provider_id: null,
          state: 'provisioning',
          address: null,
          error: null,
          created_at: input.at,
          last_active_at: input.at,
          state_changed_at: input.at,
          verified_at: input.at,
        })
        // The partial unique index: one sandbox that is not deleted per scope.
        .onConflict((conflict) =>
          conflict.column('route_key').where('state', '<>', 'deleted').doNothing()
        )
        .returningAll()
        .executeTakeFirst();
      return row ? recordOf(row) : null;
    },
    async live(routeKey) {
      const row = await db()
        .selectFrom('sandboxes')
        .selectAll()
        .where('route_key', '=', routeKey)
        .where('state', '<>', 'deleted')
        .executeTakeFirst();
      return row ? recordOf(row) : null;
    },
    async get(id) {
      const row = await db()
        .selectFrom('sandboxes')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? recordOf(row) : null;
    },
    async transition(input) {
      const result = await db()
        .updateTable('sandboxes')
        .set({
          state: input.to,
          state_changed_at: input.at,
          verified_at: input.at,
          ...(input.providerId !== undefined ? { provider_id: input.providerId } : {}),
          ...(input.address !== undefined ? { address: input.address } : {}),
          ...(input.error !== undefined ? { error: input.error } : {}),
        })
        .where('id', '=', input.id)
        .where('state', 'in', input.from)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    },
    async touch(id, at) {
      await db()
        .updateTable('sandboxes')
        .set({ last_active_at: at })
        .where('id', '=', id)
        .where('last_active_at', '<', at)
        .execute();
    },
    async verified(id, at) {
      await db().updateTable('sandboxes').set({ verified_at: at }).where('id', '=', id).execute();
    },
    async list(input) {
      if (input.states.length === 0) return [];
      let query = db().selectFrom('sandboxes').selectAll().where('state', 'in', input.states);
      if (input.lastActiveBefore) {
        query = query.where('last_active_at', '<', input.lastActiveBefore);
      }
      if (input.stateChangedBefore) {
        query = query.where('state_changed_at', '<', input.stateChangedBefore);
      }
      const rows = await query
        .orderBy('last_active_at', 'asc')
        .orderBy('id', 'asc')
        .limit(input.limit)
        .execute();
      return rows.map(recordOf);
    },
    async purgeDeleted(before) {
      const result = await db()
        .deleteFrom('sandboxes')
        .where('state', '=', 'deleted')
        .where('state_changed_at', '<', before)
        .executeTakeFirst();
      return Number(result.numDeletedRows);
    },
  };
}
