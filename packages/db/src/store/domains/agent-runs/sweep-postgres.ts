import { sql, type Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import type { AgentRunSweepStore } from './sweep-types';

const DECIDED = ['approved', 'declined', 'expired', 'answered'];

export function postgresAgentRunSweeps(db: () => Kysely<DB>): AgentRunSweepStore {
  const expireCard = (reason: string) => ({
    status: 'expired',
    decided_at: sql<Date>`NOW()`,
    archived_at: sql<Date>`NOW()`,
    result: JSON.stringify({ reason }),
    updated_at: sql<Date>`NOW()`,
  });

  return {
    async listDueWaiting(now, limit) {
      const rows = await db()
        .selectFrom('agent_runs')
        .select(['id', 'agent_id'])
        .where('status', '=', 'waiting')
        .where('waiting_until', '<=', now)
        .orderBy('waiting_until')
        .orderBy('id')
        .limit(limit)
        .execute();
      return rows.map((row) => ({ id: row.id, agentId: row.agent_id }));
    },
    async expireWaitingCard(runId, reason) {
      const claimed = await db()
        .updateTable('actionable_items')
        .set(expireCard(reason))
        .where('run_id', '=', runId)
        .where('status', '=', 'suggested')
        .executeTakeFirst();
      return Number(claimed.numUpdatedRows ?? 0) > 0;
    },
    async listWaitingWithDecidedCard(decidedBefore, limit) {
      // decided_at is a timestamp without time zone, compared as the
      // NOW()-based cutoff this replaces was: through the session's zone.
      const rows = await db()
        .selectFrom('agent_runs as r')
        .innerJoin('actionable_items as c', 'c.run_id', 'r.id')
        .select(['r.id', 'r.agent_id'])
        .where('r.status', '=', 'waiting')
        .where('c.status', 'in', DECIDED)
        .where('c.decided_at', '<=', sql<Date>`${decidedBefore}::timestamptz`)
        .orderBy('r.id')
        .orderBy('c.id')
        .limit(limit)
        .execute();
      return rows.map((row) => ({ id: row.id, agentId: row.agent_id }));
    },
    async listWaitingWithoutCard(updatedBefore, limit) {
      const rows = await db()
        .selectFrom('agent_runs as r')
        .leftJoin('actionable_items as c', 'c.run_id', 'r.id')
        .select(['r.id', 'r.agent_id'])
        .where('r.status', '=', 'waiting')
        .where('c.id', 'is', null)
        .where('r.updated_at', '<=', updatedBefore)
        .orderBy('r.id')
        .limit(limit)
        .execute();
      return rows.map((row) => ({ id: row.id, agentId: row.agent_id }));
    },
    async expireCardsOfEndedRuns() {
      const result = await db()
        .updateTable('actionable_items')
        .set(expireCard('run-ended'))
        .where('status', '=', 'suggested')
        .where('run_id', 'is not', null)
        .where(({ exists, selectFrom, not }) =>
          not(
            exists(
              selectFrom('agent_runs')
                .select('agent_runs.id')
                .whereRef('agent_runs.id', '=', 'actionable_items.run_id')
                .where('agent_runs.status', 'in', ['waiting', 'running', 'queued'])
            )
          )
        )
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0);
    },
    async pruneFinishedBefore(before, limit) {
      const deleted = await sql<{ id: string }>`
        DELETE FROM agent_runs WHERE id IN (
          SELECT id FROM agent_runs
          WHERE status IN ('succeeded', 'failed', 'canceled', 'stopped')
            AND created_at < ${before}
          ORDER BY created_at, id
          LIMIT ${limit}
        ) RETURNING id
      `.execute(db());
      return deleted.rows.length;
    },
    async listStaleInProgress(createdBefore, limit) {
      const rows = await db()
        .selectFrom('agent_runs')
        .select(['id', 'agent_id', 'owner_subject', 'started_at'])
        .where('status', 'in', ['queued', 'running'])
        .where('created_at', '<', createdBefore)
        .orderBy('created_at')
        .orderBy('id')
        .limit(limit)
        .execute();
      return rows.map((row) => ({
        id: row.id,
        agentId: row.agent_id,
        ownerSubject: row.owner_subject,
        startedAt: row.started_at === null ? null : new Date(row.started_at),
      }));
    },
    async failAbandoned(runId, { errorKind, error }) {
      const result = await db()
        .updateTable('agent_runs')
        .set({
          status: 'failed',
          error_kind: errorKind,
          error,
          finished_at: sql`NOW()`,
          updated_at: sql`NOW()`,
        })
        .where('id', '=', runId)
        .where('status', 'in', ['queued', 'running'])
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0) > 0;
    },
  };
}
