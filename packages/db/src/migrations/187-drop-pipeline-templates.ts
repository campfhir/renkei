import { Kysely, sql } from 'kysely';

/**
 * Pipeline templates are gone: a code project's pipeline is built from the
 * organization's building blocks (ci_blocks) on its app's Pipeline tab
 * under Deployments, or written by hand there, so the catalog of starting
 * YAML files (migration 121) and its admin page went with the picker that
 * offered them. `down` puts the table back empty, as single-organization
 * Renkei had it (migration 153).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('pipeline_templates').ifExists().execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('pipeline_templates')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('provider', 'varchar(50)', (col) => col.notNull().defaultTo('atlassian-bitbucket'))
    .addColumn('name', 'varchar(200)', (col) => col.notNull())
    .addColumn('description', 'text')
    .addColumn('body', 'text', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();
  await db.schema
    .createIndex('idx_pipeline_templates_provider_name')
    .unique()
    .on('pipeline_templates')
    .columns(['provider', 'name'])
    .execute();
}
