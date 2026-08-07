import { Kysely, sql } from 'kysely';

/**
 * Settings move into the database — the environment shrinks to what is
 * needed BEFORE the database can answer: the connection itself, the root
 * encryption key (which cannot live beside the data it seals), and process
 * wiring. Everything else is policy, and policy is data.
 *
 * Two scopes:
 * - `platform_settings`: deployment-scoped key/value (public_base_url, …).
 *   Deliberately no tenant FK — these describe the installation, not an org.
 * - `tenant_settings`: org-scoped policy (read_only, token TTLs, limits, …)
 *   per Decision #13: org-admins set org defaults and limits. Every value is
 *   jsonb; typed readers with defaults live in @renkei/settings.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('platform_settings')
    .addColumn('key', 'varchar(128)', (col) => col.primaryKey())
    .addColumn('value', 'jsonb', (col) => col.notNull())
    .addColumn('updated_at', 'timestamp', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();

  await db.schema
    .createTable('tenant_settings')
    .addColumn('tenant_id', 'uuid', (col) => col.notNull().references('tenants.id'))
    .addColumn('key', 'varchar(128)', (col) => col.notNull())
    .addColumn('value', 'jsonb', (col) => col.notNull())
    .addColumn('updated_at', 'timestamp', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addPrimaryKeyConstraint('tenant_settings_pk', ['tenant_id', 'key'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('tenant_settings').execute();
  await db.schema.dropTable('platform_settings').execute();
}
