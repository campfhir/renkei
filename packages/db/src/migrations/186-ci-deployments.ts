import { Kysely, sql } from 'kysely';

/**
 * Deployments, as each deploy step of a pipeline built from blocks reports
 * them (POST /api/deployments/report, signed by the host with OpenID
 * Connect): one row per run of a step deploying an environment, written
 * when it starts and updated when it succeeds or fails. `run_id` is the
 * host's run, so a report sent twice updates the row it already wrote.
 *
 * `ci_pipelines.repo_key` is how a report finds its project: the
 * repository as the host's token names it — GitHub's `owner/name`, lower
 * case; Bitbucket's repository UUID, without braces.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('ci_pipelines').addColumn('repo_key', 'varchar(255)').execute();
  await db.schema
    .createIndex('idx_ci_pipelines_repo_key')
    .on('ci_pipelines')
    .columns(['host', 'repo_key'])
    .execute();
  await db.schema
    .createTable('ci_deployments')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('project_id', 'uuid', (col) =>
      col.notNull().references('chat_projects.id').onDelete('cascade')
    )
    .addColumn('environment', 'varchar(40)', (col) => col.notNull())
    .addColumn('status', 'varchar(16)', (col) => col.notNull())
    .addColumn('commit_sha', 'varchar(64)', (col) => col.notNull())
    .addColumn('branch', 'varchar(255)')
    .addColumn('target', 'varchar(50)')
    .addColumn('run_id', 'varchar(120)', (col) => col.notNull())
    .addColumn('run_url', 'text')
    .addColumn('detail', 'text')
    .addColumn('actor', 'varchar(255)')
    .addColumn('started_at', 'timestamptz', (col) => col.notNull())
    .addColumn('finished_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();
  await db.schema
    .createIndex('idx_ci_deployments_run')
    .unique()
    .on('ci_deployments')
    .columns(['project_id', 'environment', 'run_id'])
    .execute();
  await db.schema
    .createIndex('idx_ci_deployments_project_started')
    .on('ci_deployments')
    .columns(['project_id', 'started_at'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('ci_deployments').execute();
  await db.schema.dropIndex('idx_ci_pipelines_repo_key').execute();
  await db.schema.alterTable('ci_pipelines').dropColumn('repo_key').execute();
}
