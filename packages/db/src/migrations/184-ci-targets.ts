import { Kysely, sql } from 'kysely';

/**
 * CI targets: where a building block that runs on a target runs (a group
 * of self-hosted runners today; Azure services later, as their own kind).
 * `labels` is each host's runner labels, `{ bitbucket: [...], github:
 * [...] }` — what a pipeline's `runs-on` gets there. The runners
 * themselves are read live from each host, never stored. A pipeline names
 * a target by its name.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('ci_targets')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('name', 'varchar(50)', (col) => col.notNull())
    .addColumn('description', 'text')
    .addColumn('kind', 'varchar(16)', (col) => col.notNull().defaultTo('runners'))
    .addColumn('labels', 'jsonb', (col) => col.notNull())
    .addColumn('created_by', 'varchar(255)')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();
  await db.schema
    .createIndex('idx_ci_targets_name')
    .unique()
    .on('ci_targets')
    .column('name')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('ci_targets').execute();
}
