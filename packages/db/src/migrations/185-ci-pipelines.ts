import { Kysely, sql } from 'kysely';

/**
 * A code project's pipeline, built from the organization's blocks (one per
 * project): `spec` is the pipeline as @renkei/ci-blocks reads it — the
 * pull-request checks and each environment's branch and steps — and
 * `host` the host it was built for. `written_text` is the file as the
 * builder last put it in a pull request, so a later edit made by hand on
 * the branch can be told apart; `pull_request_url` is that pull request.
 * Goes with its project.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('ci_pipelines')
    .addColumn('project_id', 'uuid', (col) =>
      col.primaryKey().references('chat_projects.id').onDelete('cascade')
    )
    .addColumn('host', 'varchar(16)', (col) => col.notNull())
    .addColumn('spec', 'jsonb', (col) => col.notNull())
    .addColumn('written_text', 'text')
    .addColumn('written_at', 'timestamptz')
    .addColumn('pull_request_url', 'text')
    .addColumn('updated_by', 'varchar(255)', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('ci_pipelines').execute();
}
