import { Kysely, sql } from 'kysely';

/**
 * Per-tenant connector configuration — in the database, not environment
 * variables, because connectors are provisioned by org-admins at runtime
 * (RENKEI.md Decision #13): which connectors the org runs, with what
 * credentials, is policy data, not deployment shape.
 *
 * `settings` holds inspectable, non-secret configuration; `encrypted_secrets`
 * holds a secretbox-sealed JSON object (bot tokens, webhook secrets) under
 * the deployment key, the same envelope as provider grants. The deployment
 * key itself stays in the environment — it is the root that unlocks
 * everything at rest and cannot live beside the data it protects.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('connector_configs')
    .addColumn('tenant_id', 'uuid', (col) => col.notNull().references('tenants.id'))
    .addColumn('connector', 'varchar(64)', (col) => col.notNull())
    .addColumn('enabled', 'boolean', (col) => col.notNull().defaultTo(true))
    .addColumn('settings', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('encrypted_secrets', 'text', (col) => col.notNull())
    .addColumn('created_at', 'timestamp', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamp', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addPrimaryKeyConstraint('connector_configs_pk', ['tenant_id', 'connector'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('connector_configs').execute();
}
