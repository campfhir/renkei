import { Kysely, sql } from 'kysely';

/**
 * How a host's tokens name a code project's repository — GitHub's
 * `owner/name`, lower case; Bitbucket's repository UUID, without braces —
 * kept for the project itself, so a deploy step's report (signed by the
 * host with OpenID Connect) finds its project whether or not the pipeline
 * that sends it was built in Renkei. `ci_pipelines.repo_key` (migration
 * 186) records the same for a pipeline built from blocks; a pipeline
 * written by hand has no row there, and reports through this one once a
 * person takes the report step for it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE ci_repo_keys (
      project_id UUID PRIMARY KEY REFERENCES chat_projects(id) ON DELETE CASCADE,
      host VARCHAR(16) NOT NULL,
      repo_key VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db);
  await sql`CREATE INDEX idx_ci_repo_keys_key ON ci_repo_keys (host, repo_key)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS ci_repo_keys`.execute(db);
}
