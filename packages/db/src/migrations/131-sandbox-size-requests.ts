import { Kysely, sql } from 'kysely';

/**
 * A person's request for a larger code-workspace checkout than the org's
 * limit allows, and the admin's decision on it.
 *
 * The org-wide limit is a tenant setting (sandboxWorkspaceMaxBytes). This
 * table is the exception path: one row per ask, `pending` until an admin
 * approves or denies it. An approved row raises the limit for that
 * subject only — the sandbox worker takes the larger of the org limit and
 * the subject's largest approved request — so one big monorepo does not
 * widen the ceiling for everyone.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('sandbox_size_requests')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('subject', 'text', (col) => col.notNull())
    .addColumn('requested_by', 'text', (col) => col.notNull())
    .addColumn('requested_bytes', 'bigint', (col) => col.notNull())
    .addColumn('reason', 'text', (col) => col.notNull().defaultTo(''))
    .addColumn('status', 'text', (col) =>
      col
        .notNull()
        .defaultTo('pending')
        .check(sql`status IN ('pending', 'approved', 'denied')`)
    )
    .addColumn('decided_by', 'text')
    .addColumn('decided_at', 'timestamptz')
    .addColumn('decision_note', 'text')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();

  await db.schema
    .createIndex('sandbox_size_requests_tenant_status_idx')
    .on('sandbox_size_requests')
    .columns(['tenant_id', 'status', 'created_at'])
    .execute();
  await db.schema
    .createIndex('sandbox_size_requests_subject_idx')
    .on('sandbox_size_requests')
    .columns(['tenant_id', 'subject'])
    .execute();
  // One open ask per workspace subject: a second while the first waits is a duplicate.
  await sql`CREATE UNIQUE INDEX sandbox_size_requests_one_pending_idx
    ON sandbox_size_requests (tenant_id, subject) WHERE status = 'pending'`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('sandbox_size_requests').execute();
}
