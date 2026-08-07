import { Kysely, sql } from 'kysely';

/**
 * Generalize the token-refresh lock table for multiple providers.
 *
 * The grant lifecycle is moving behind a provider interface
 * (@renkei/provider-grants); the lock that serializes cross-process token
 * refresh must key on the provider too, or two providers sharing an account
 * identifier would contend on one lock. The old table held only transient
 * locks (staleness-reclaimed after 5 minutes), so dropping it loses nothing.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('atlassian_refresh_locks').execute();

  await db.schema
    .createTable('provider_refresh_locks')
    .addColumn('tenant_id', 'uuid', (col) => col.notNull())
    .addColumn('provider', 'varchar(64)', (col) => col.notNull())
    .addColumn('account_id', 'varchar(255)', (col) => col.notNull())
    .addColumn('locked_at', 'timestamp', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addPrimaryKeyConstraint('provider_refresh_locks_pk', ['tenant_id', 'provider', 'account_id'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('provider_refresh_locks').execute();

  await db.schema
    .createTable('atlassian_refresh_locks')
    .addColumn('tenant_id', 'uuid', (col) => col.notNull())
    .addColumn('account_id', 'varchar(255)', (col) => col.notNull())
    .addColumn('locked_at', 'timestamp', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addPrimaryKeyConstraint('atlassian_refresh_locks_pk', ['tenant_id', 'account_id'])
    .execute();
}
