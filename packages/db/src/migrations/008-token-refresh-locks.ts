import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // Distributed mutex for token refresh operations.
  // Prevents race conditions when multiple processes try to refresh the same grant.
  // Lock is acquired by inserting; lock is released by deleting.
  // Stale locks (older than 5 minutes) should be cleaned up periodically.
  await db.schema
    .createTable('atlassian_refresh_locks')
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('account_id', 'varchar(255)', (col) => col.notNull())
    .addColumn('locked_at', 'timestamp', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addPrimaryKeyConstraint('pk_refresh_locks', ['tenant_id', 'account_id'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('atlassian_refresh_locks').execute();
}
