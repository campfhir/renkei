import { Kysely, sql } from 'kysely';

/**
 * A code project's environments, and a pipeline per branch.
 *
 * `ci_environments` is the project's own list — production, dev, staging,
 * whatever it calls them — in the order the project keeps them, each with
 * the branches of the repository assigned to it (`branches`, a JSON array
 * of names). One of them is the production environment; that there is one,
 * that it holds at most one branch and that a branch sits in one
 * environment are the application's rules (the web app's
 * lib/ci/environments.ts), not the table's.
 *
 * A pipeline file lives on a branch, so `ci_pipelines` is now one row per
 * project and branch: what the builder keeps for that branch, deploying
 * the environment the branch is assigned to. A pipeline saved before this
 * held every environment in one row; it becomes an environment per entry
 * and a row per branch, each keeping the pull-request checks and that
 * environment's steps. What was written to the old single file is not
 * carried over: the next pull request writes each branch's own.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE ci_environments (
      project_id UUID NOT NULL REFERENCES chat_projects(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      name VARCHAR(40) NOT NULL,
      production BOOLEAN NOT NULL DEFAULT FALSE,
      branches JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_by VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (project_id, position)
    )
  `.execute(db);
  await sql`
    INSERT INTO ci_environments (project_id, position, name, production, branches, updated_by)
    SELECT p.project_id,
           (e.ord - 1)::int,
           LEFT(e.value->>'name', 40),
           LOWER(e.value->>'name') = 'production',
           jsonb_build_array(e.value->>'branch'),
           p.updated_by
    FROM ci_pipelines p,
         jsonb_array_elements(
           CASE WHEN jsonb_typeof(p.spec->'environments') = 'array'
                THEN p.spec->'environments' ELSE '[]'::jsonb END
         ) WITH ORDINALITY AS e(value, ord)
    WHERE e.value->>'name' IS NOT NULL AND e.value->>'branch' IS NOT NULL
  `.execute(db);

  await sql`ALTER TABLE ci_pipelines ADD COLUMN branch VARCHAR(255) NOT NULL DEFAULT ''`.execute(
    db
  );
  await sql`ALTER TABLE ci_pipelines DROP CONSTRAINT ci_pipelines_pkey`.execute(db);
  await sql`
    INSERT INTO ci_pipelines
      (project_id, branch, host, spec, repo_key, updated_by, created_at, updated_at)
    SELECT DISTINCT ON (p.project_id, e.value->>'branch')
           p.project_id,
           e.value->>'branch',
           p.host,
           jsonb_set(p.spec, '{environments}', jsonb_build_array(e.value)),
           p.repo_key,
           p.updated_by,
           p.created_at,
           p.updated_at
    FROM ci_pipelines p,
         jsonb_array_elements(
           CASE WHEN jsonb_typeof(p.spec->'environments') = 'array'
                THEN p.spec->'environments' ELSE '[]'::jsonb END
         ) WITH ORDINALITY AS e(value, ord)
    WHERE e.value->>'name' IS NOT NULL
      AND COALESCE(e.value->>'branch', '') <> ''
    ORDER BY p.project_id, e.value->>'branch', e.ord
  `.execute(db);
  await sql`DELETE FROM ci_pipelines WHERE branch = ''`.execute(db);
  await sql`ALTER TABLE ci_pipelines ALTER COLUMN branch DROP DEFAULT`.execute(db);
  await sql`ALTER TABLE ci_pipelines ADD PRIMARY KEY (project_id, branch)`.execute(db);
}

/** Back to one pipeline a project: the per-branch rows cannot be folded into one, so they go. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DELETE FROM ci_pipelines`.execute(db);
  await sql`ALTER TABLE ci_pipelines DROP CONSTRAINT ci_pipelines_pkey`.execute(db);
  await sql`ALTER TABLE ci_pipelines DROP COLUMN branch`.execute(db);
  await sql`ALTER TABLE ci_pipelines ADD PRIMARY KEY (project_id)`.execute(db);
  await sql`DROP TABLE IF EXISTS ci_environments`.execute(db);
}
