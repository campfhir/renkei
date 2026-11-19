import { Kysely, sql } from 'kysely';

/**
 * The pipeline builder's assistant, answered in the background: one row a
 * question. The web app answers the question's POST at once with the row's
 * id and works it out after the response (Next's `after()`); the page asks
 * for the row until it ends. While it works, `step` says what it is doing
 * ("Reading package.json") and each write moves `updated_at`, the
 * heartbeat that tells a slow answer from one whose process went away (the
 * reader calls a row silent for minutes interrupted).
 *
 * The question itself is not kept: it lives in the process working on it.
 * `result` is the answer (the reply and any proposal), `error` why there
 * is none. Rows older than a day are deleted as new ones are made.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE ci_assistant_jobs (
      id UUID PRIMARY KEY,
      subject TEXT NOT NULL,
      project_id UUID NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      step TEXT,
      result JSONB,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ
    )
  `.execute(db);
  await sql`CREATE INDEX idx_ci_assistant_jobs_created ON ci_assistant_jobs (created_at)`.execute(
    db
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS ci_assistant_jobs`.execute(db);
}
