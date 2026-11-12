import { sql, type Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import { ARTIFACT_BULK_JOBS as TABLE, artifactBulkJobFromRow, resultsValue } from './record';
import type { ArtifactBulkJobStore } from './types';

const changed = (result: { numUpdatedRows?: bigint }) => Number(result.numUpdatedRows ?? 0) > 0;
const staleBefore = (staleMs: number) => sql<Date>`NOW() - (${staleMs} * INTERVAL '1 millisecond')`;

export function postgresArtifactBulkJobs(db: () => Kysely<DB>): ArtifactBulkJobStore {
  return {
    async create(job) {
      const row = await db()
        .insertInto(TABLE)
        .values({
          id: job.id,
          subject: job.subject,
          action: job.action,
          project_id: job.projectId,
          mode: job.mode,
          artifact_ids: JSON.stringify(job.artifactIds),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return artifactBulkJobFromRow(row);
    },
    async get(id) {
      const row = await db().selectFrom(TABLE).selectAll().where('id', '=', id).executeTakeFirst();
      return row ? artifactBulkJobFromRow(row) : null;
    },
    async listShown(subject, limit) {
      const rows = await db()
        .selectFrom(TABLE)
        .selectAll()
        .where('subject', '=', subject)
        .where('dismissed_at', 'is', null)
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(limit)
        .execute();
      return rows.map(artifactBulkJobFromRow);
    },
    async startQueued(id) {
      const result = await db()
        .updateTable(TABLE)
        .set({ status: 'running', updated_at: sql<Date>`NOW()` })
        .where('id', '=', id)
        .where('status', '=', 'queued')
        .executeTakeFirst();
      return changed(result);
    },
    async reclaimStale(id, staleMs) {
      const result = await db()
        .updateTable(TABLE)
        .set({ updated_at: sql<Date>`NOW()` })
        .where('id', '=', id)
        .where('status', '=', 'running')
        .where('updated_at', '<', staleBefore(staleMs))
        .executeTakeFirst();
      return changed(result);
    },
    async recordResults(id, results) {
      const result = await db()
        .updateTable(TABLE)
        .set({ results: JSON.stringify(resultsValue(results)), updated_at: sql<Date>`NOW()` })
        .where('id', '=', id)
        .where('status', '=', 'running')
        .executeTakeFirst();
      return changed(result);
    },
    async finish(id, outcome) {
      const result = await db()
        .updateTable(TABLE)
        .set({
          status: outcome.status,
          ...(outcome.lastError !== undefined ? { last_error: outcome.lastError } : {}),
          finished_at: sql<Date>`NOW()`,
          updated_at: sql<Date>`NOW()`,
          ...(outcome.dismiss ? { dismissed_at: sql<Date>`NOW()` } : {}),
        })
        .where('id', '=', id)
        .where('status', 'in', ['queued', 'running'])
        .executeTakeFirst();
      return changed(result);
    },
    async dismiss(id, subject) {
      const result = await db()
        .updateTable(TABLE)
        .set({ dismissed_at: sql<Date>`NOW()` })
        .where('id', '=', id)
        .where('subject', '=', subject)
        .where('finished_at', 'is not', null)
        .where('dismissed_at', 'is', null)
        .executeTakeFirst();
      return changed(result);
    },
    async listRunnable(staleMs, limit) {
      const rows = await db()
        .selectFrom(TABLE)
        .select(['id', 'status'])
        .where((eb) =>
          eb.or([
            eb('status', '=', 'queued'),
            eb.and([eb('status', '=', 'running'), eb('updated_at', '<', staleBefore(staleMs))]),
          ])
        )
        .orderBy('updated_at', 'asc')
        .orderBy('id')
        .limit(limit)
        .execute();
      return rows.map((row) => ({
        id: row.id,
        status: row.status === 'queued' ? ('queued' as const) : ('running' as const),
      }));
    },
  };
}
