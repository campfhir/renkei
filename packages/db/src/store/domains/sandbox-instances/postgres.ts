import { sql, type Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import type { SandboxInstanceStore } from './types';

export function postgresSandboxInstances(db: () => Kysely<DB>): SandboxInstanceStore {
  return {
    async heartbeat(instance) {
      await db()
        .insertInto('sandbox_instances')
        .values({
          id: instance.id,
          address: instance.address,
          started_at: instance.startedAt,
          last_seen_at: instance.at,
        })
        .onConflict((conflict) =>
          conflict.column('id').doUpdateSet({
            address: instance.address,
            started_at: instance.startedAt,
            last_seen_at: instance.at,
          })
        )
        .execute();
    },
    async removeUnseenSince(before) {
      const result = await db()
        .deleteFrom('sandbox_instances')
        .where('last_seen_at', '<', before)
        .executeTakeFirst();
      return Number(result.numDeletedRows);
    },
    async listLive(since) {
      const rows = await db()
        .selectFrom('sandbox_instances as i')
        .select((eb) => [
          'i.id',
          'i.address',
          'i.started_at',
          'i.last_seen_at',
          eb
            .selectFrom('sandbox_assignments as a')
            .select(sql<string>`count(*)`.as('n'))
            .whereRef('a.instance_id', '=', 'i.id')
            .as('assigned'),
        ])
        .where('i.last_seen_at', '>=', since)
        .execute();
      return rows
        .map((row) => ({
          id: row.id,
          address: row.address,
          startedAt: row.started_at,
          lastSeenAt: row.last_seen_at,
          assigned: Number(row.assigned ?? 0),
        }))
        .sort((a, b) => a.assigned - b.assigned || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    },
    async assignment(subject) {
      const row = await db()
        .selectFrom('sandbox_assignments as a')
        .leftJoin('sandbox_instances as i', 'i.id', 'a.instance_id')
        .select([
          'a.subject',
          'a.instance_id',
          'a.assigned_at',
          'i.id as live_id',
          'i.address',
          'i.started_at',
          'i.last_seen_at',
        ])
        .where('a.subject', '=', subject)
        .executeTakeFirst();
      if (!row) return null;
      return {
        subject: row.subject,
        instanceId: row.instance_id,
        assignedAt: row.assigned_at,
        instance:
          row.live_id !== null && row.address !== null && row.started_at && row.last_seen_at
            ? {
                id: row.live_id,
                address: row.address,
                startedAt: row.started_at,
                lastSeenAt: row.last_seen_at,
              }
            : null,
      };
    },
    async assign(input) {
      if (input.replacing === null) {
        await db()
          .insertInto('sandbox_assignments')
          .values({ subject: input.subject, instance_id: input.instanceId, assigned_at: input.at })
          .onConflict((conflict) => conflict.column('subject').doNothing())
          .execute();
      } else {
        await db()
          .updateTable('sandbox_assignments')
          .set({ instance_id: input.instanceId, assigned_at: input.at })
          .where('subject', '=', input.subject)
          .where('instance_id', '=', input.replacing)
          .execute();
      }
      const row = await db()
        .selectFrom('sandbox_assignments')
        .select('instance_id')
        .where('subject', '=', input.subject)
        .executeTakeFirst();
      // With `replacing` set and no row at all, nothing was there to move: say what was asked for.
      return row?.instance_id ?? input.instanceId;
    },
  };
}
