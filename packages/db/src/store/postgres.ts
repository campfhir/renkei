import { sql, type Kysely, type Selectable } from 'kysely';
import type { CoachMarkProgress, DB } from '../db.types';
import type {
  CoachMarkProgressRecord,
  DataStore,
  NotificationRecord,
  NotificationTarget,
} from './types';

/**
 * The production data store: each repository is the Kysely it replaced,
 * moved out of the call site. `db` is resolved per call, not at
 * construction, so building the store never needs a connection and a
 * missing DATABASE_URL surfaces where it always did — as the failed query.
 */
export function createPostgresDataStore(db: () => Kysely<DB>): DataStore {
  return {
    kind: 'postgres',

    sessions: {
      async create({ id, subject, roles, expiresAt }) {
        await db()
          .insertInto('sessions')
          .values({ id, subject, roles, expires_at: expiresAt })
          .execute();
      },
      async find(id) {
        const row = await db()
          .selectFrom('sessions')
          .select(['id', 'subject', 'roles', 'expires_at', 'last_used_at'])
          .where('id', '=', id)
          .executeTakeFirst();
        if (!row) return null;
        return {
          id: row.id,
          subject: row.subject,
          roles: row.roles,
          expiresAt: new Date(row.expires_at),
          lastUsedAt: new Date(row.last_used_at),
        };
      },
      async touch(id, at) {
        await db().updateTable('sessions').set({ last_used_at: at }).where('id', '=', id).execute();
      },
      async delete(id) {
        await db().deleteFrom('sessions').where('id', '=', id).execute();
      },
    },

    identities: {
      async get(subject) {
        const row = await db()
          .selectFrom('identities')
          .select(['subject', 'email', 'display_name', 'idp_groups'])
          .where('subject', '=', subject)
          .executeTakeFirst();
        return row
          ? {
              subject: row.subject,
              email: row.email,
              displayName: row.display_name,
              idpGroups: row.idp_groups ?? [],
            }
          : null;
      },
      async upsert({ subject, email, displayName, idpGroups }) {
        await db()
          .insertInto('identities')
          .values({ subject, email, display_name: displayName, idp_groups: idpGroups })
          .onConflict((oc) =>
            oc.columns(['subject']).doUpdateSet({
              email,
              display_name: displayName,
              idp_groups: idpGroups,
              updated_at: new Date().toISOString(),
            })
          )
          .execute();
      },
      async clearGroups(subject) {
        await db()
          .updateTable('identities')
          .set({ idp_groups: [], updated_at: new Date().toISOString() })
          .where('subject', '=', subject)
          .execute();
      },
      async list() {
        const rows = await db()
          .selectFrom('identities')
          .select(['subject', 'email', 'display_name', 'idp_groups'])
          .orderBy('display_name', 'asc')
          .orderBy('email', 'asc')
          .execute();
        return rows.map((row) => ({
          subject: row.subject,
          email: row.email,
          displayName: row.display_name,
          idpGroups: row.idp_groups ?? [],
        }));
      },
    },

    userPreferences: {
      async get(subject, key) {
        const row = await db()
          .selectFrom('user_preferences')
          .select('value')
          .where('subject', '=', subject)
          .where('key', '=', key)
          .executeTakeFirst();
        return row?.value;
      },
      async set(subject, key, value) {
        const now = new Date().toISOString();
        const json = JSON.stringify(value);
        await db()
          .insertInto('user_preferences')
          .values({ subject, key, value: json, updated_at: now })
          .onConflict((oc) =>
            oc.columns(['subject', 'key']).doUpdateSet({ value: json, updated_at: now })
          )
          .execute();
      },
    },

    settings: {
      async all() {
        const rows = await db().selectFrom('settings').select(['key', 'value']).execute();
        return new Map<string, unknown>(rows.map((row) => [row.key, row.value]));
      },
      async get(key) {
        const row = await db()
          .selectFrom('settings')
          .select('value')
          .where('key', '=', key)
          .executeTakeFirst();
        return row?.value;
      },
      async set(key, value) {
        const now = new Date().toISOString();
        const json = JSON.stringify(value);
        await db()
          .insertInto('settings')
          .values({ key, value: json, updated_at: now })
          .onConflict((oc) => oc.columns(['key']).doUpdateSet({ value: json, updated_at: now }))
          .execute();
      },
    },

    coachMarks: {
      async list(subject) {
        const rows = await db()
          .selectFrom('coach_mark_progress')
          .selectAll()
          .where('subject', '=', subject)
          .orderBy('tour_id')
          .execute();
        return rows.map(coachMarkFromRow);
      },
      async apply(subject, tourId, next) {
        // Advisory rather than SELECT … FOR UPDATE: the first report of a
        // tour has no row to lock yet.
        const lockKey = `coach_mark_progress:${subject}:${tourId}`;
        return db()
          .transaction()
          .execute(async (trx) => {
            await sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`.execute(trx);
            const existing = await trx
              .selectFrom('coach_mark_progress')
              .selectAll()
              .where('subject', '=', subject)
              .where('tour_id', '=', tourId)
              .executeTakeFirst();
            const record = next(existing ? coachMarkFromRow(existing) : null);
            const now = new Date().toISOString();
            const values = {
              tour_version: record.version,
              status: record.status,
              step_reached: record.stepReached,
              steps_total: record.stepsTotal,
              view_count: record.viewCount,
              completed_count: record.completedCount,
              dismissed_count: record.dismissedCount,
              last_viewed_at: record.lastViewedAt,
              completed_at: record.completedAt,
              dismissed_at: record.dismissedAt,
              reported_at: record.reportedAt,
              updated_at: now,
            };
            await trx
              .insertInto('coach_mark_progress')
              .values({
                subject,
                tour_id: tourId,
                first_viewed_at: record.firstViewedAt,
                ...values,
              })
              .onConflict((oc) => oc.columns(['subject', 'tour_id']).doUpdateSet(values))
              .execute();
            return record;
          });
      },
      async listAll() {
        const rows = await db()
          .selectFrom('coach_mark_progress')
          .selectAll()
          .orderBy('updated_at', 'desc')
          .execute();
        return rows.map((row) => ({ subject: row.subject, progress: coachMarkFromRow(row) }));
      },
    },

    notifications: {
      async list(subject, { limit, since, before, unreadOnly }) {
        let query = db()
          .selectFrom('agent_notifications')
          .selectAll()
          .where('subject', '=', subject)
          .orderBy('created_at', 'desc')
          .limit(limit);
        if (since) query = query.where('created_at', '>', since);
        if (before) query = query.where('created_at', '<', before);
        if (unreadOnly) query = query.where('read_at', 'is', null);
        const rows = await query.execute();
        return rows.map((row): NotificationRecord => ({
          id: row.id,
          subject: row.subject,
          kind: row.kind,
          category: row.category,
          connector: row.connector,
          tool: row.tool,
          entity: row.entity,
          headline: row.headline,
          refUrl: row.ref_url,
          agentId: row.agent_id,
          agentName: row.agent_name,
          runId: row.run_id,
          meta: row.meta ?? null,
          readAt: row.read_at ? new Date(row.read_at) : null,
          createdAt: new Date(row.created_at),
        }));
      },
      async countUnread(subject) {
        const row = await db()
          .selectFrom('agent_notifications')
          .select((eb) => eb.fn.countAll<string>().as('count'))
          .where('subject', '=', subject)
          .where('read_at', 'is', null)
          .executeTakeFirst();
        return Number(row?.count ?? 0);
      },
      async mark(subject, target, { unread }) {
        if (isEmptyTarget(target)) return 0;
        let update = db()
          .updateTable('agent_notifications')
          .set({ read_at: unread ? null : new Date() })
          .where('subject', '=', subject)
          .where('read_at', unread ? 'is not' : 'is', null);
        if ('ids' in target) update = update.where('id', 'in', target.ids);
        const result = await update.executeTakeFirst();
        return Number(result.numUpdatedRows ?? 0);
      },
      async delete(subject, target) {
        if (isEmptyTarget(target)) return 0;
        let del = db().deleteFrom('agent_notifications').where('subject', '=', subject);
        if ('ids' in target) del = del.where('id', 'in', target.ids);
        const result = await del.executeTakeFirst();
        return Number(result.numDeletedRows ?? 0);
      },
      async insert(notification) {
        await db()
          .insertInto('agent_notifications')
          .values({
            id: notification.id,
            subject: notification.subject,
            kind: notification.kind,
            category: notification.category,
            connector: notification.connector,
            tool: notification.tool,
            entity: notification.entity,
            headline: notification.headline,
            ref_url: notification.refUrl,
            agent_id: notification.agentId,
            agent_name: notification.agentName,
            run_id: notification.runId,
            meta:
              notification.meta === null || notification.meta === undefined
                ? null
                : JSON.stringify(notification.meta),
            read_at: notification.readAt ?? null,
            ...(notification.createdAt ? { created_at: notification.createdAt } : {}),
          })
          .execute();
      },
    },
  };
}

/** `where id in ()` is a syntax error in Postgres; an empty id list reaches nothing anyway. */
function isEmptyTarget(target: NotificationTarget): boolean {
  return 'ids' in target && target.ids.length === 0;
}

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

function coachMarkFromRow(row: Selectable<CoachMarkProgress>): CoachMarkProgressRecord {
  return {
    tourId: row.tour_id,
    version: row.tour_version,
    status: row.status,
    stepReached: row.step_reached,
    stepsTotal: row.steps_total,
    viewCount: row.view_count,
    completedCount: row.completed_count,
    dismissedCount: row.dismissed_count,
    firstViewedAt: iso(row.first_viewed_at),
    lastViewedAt: iso(row.last_viewed_at),
    completedAt: row.completed_at === null ? null : iso(row.completed_at),
    dismissedAt: row.dismissed_at === null ? null : iso(row.dismissed_at),
    reportedAt: iso(row.reported_at),
  };
}
