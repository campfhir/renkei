import { sql, type Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import type { AdminChangeQueueStore } from './types';

export function postgresAdminChangeQueue(db: () => Kysely<DB>): AdminChangeQueueStore {
  return {
    async operatorSubjects(role) {
      const rows = await sql<{ subject: string }>`
        SELECT subject FROM sessions WHERE ${role} = ANY(roles)
        UNION
        SELECT subject FROM oauth_access_tokens WHERE ${role} = ANY(roles)
        ORDER BY subject
      `.execute(db());
      return rows.rows.map((row) => row.subject);
    },
    async recordNotice(notice) {
      await db()
        .insertInto('agent_notifications')
        .values({
          id: notice.id,
          subject: notice.subject,
          kind: notice.kind,
          connector: notice.connector,
          entity: notice.entity,
          headline: notice.headline,
          ref_id: notice.refId,
          ref_url: notice.refUrl,
        })
        .execute();
    },
    async agentName(agentId) {
      const row = await db()
        .selectFrom('agents')
        .select('name')
        .where('id', '=', agentId)
        .executeTakeFirst();
      return row?.name ?? null;
    },
  };
}
