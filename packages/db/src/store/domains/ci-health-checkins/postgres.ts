import { sql, type Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import { ciHealthFromRow } from './record';
import type { CiHealthStore } from './types';

export function postgresCiHealth(db: () => Kysely<DB>): CiHealthStore {
  return {
    async listForProject(projectId) {
      const rows = await db()
        .selectFrom('ci_health_checkins')
        .selectAll()
        .where('project_id', '=', projectId)
        .orderBy('environment')
        .execute();
      return rows.map(ciHealthFromRow);
    },
    async issueToken(projectId, environment, token) {
      await db()
        .insertInto('ci_health_checkins')
        .values({
          project_id: projectId,
          environment,
          token_hash: token.hash,
          token_hint: token.hint,
          issued_by: token.issuedBy,
          issued_at: token.at,
        })
        .onConflict((oc) =>
          oc.columns(['project_id', 'environment']).doUpdateSet({
            token_hash: token.hash,
            token_hint: token.hint,
            issued_by: token.issuedBy,
            issued_at: token.at,
          })
        )
        .execute();
    },
    async revoke(projectId, environment) {
      const result = await db()
        .deleteFrom('ci_health_checkins')
        .where('project_id', '=', projectId)
        .where('environment', '=', environment)
        .executeTakeFirst();
      return Number(result.numDeletedRows ?? 0) > 0;
    },
    async checkIn(tokenHash, checkin) {
      const row = await db()
        .updateTable('ci_health_checkins')
        .set({
          status: checkin.status,
          message: checkin.message,
          version: checkin.version,
          sent_at: checkin.sentAt,
          received_at: checkin.receivedAt,
          interval_seconds: checkin.intervalSeconds,
          checkins: sql`checkins + 1`,
        })
        .where('token_hash', '=', tokenHash)
        .returningAll()
        .executeTakeFirst();
      return row ? ciHealthFromRow(row) : null;
    },
  };
}
