import { Kysely, sql } from 'kysely';

/**
 * An artifact's digest: a short summary and a list of keywords the
 * organization's default model writes for a file when it lands
 * (apps/web/lib/chat/artifact-digest.ts), kept IN THE CLEAR beside the
 * sealed text so the library can be searched by what a file is about
 * without opening it (docs/artifacts-design.md, "Search").
 *
 *   - `summary`, `keywords`: what the model wrote; empty until it has.
 *   - `digest_status`: `none` (no text to digest), `pending` (text is
 *     there, the model has not answered yet), `running` (a digest is in
 *     flight), `done`, or `failed` (the model's answer could not be used;
 *     a replacement starts over).
 *   - `search_vector`: the keywords (weight A) and the summary (weight B)
 *     as Postgres full-text terms, written together with them by the one
 *     place that stores a digest (`array_to_string` is not immutable, so
 *     the database cannot generate the column itself) and indexed, so a
 *     search is one indexed predicate and never a scan of sealed text.
 *     Filenames are matched by substring in the query, not here.
 *
 * Rows that already have text are marked `pending`: the library page
 * digests the pending rows it shows, a few at a time, so the backlog
 * fills in as people look at their files.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('artifacts')
    .addColumn('summary', 'text')
    .addColumn('keywords', sql`text[]`, (col) => col.notNull().defaultTo(sql`'{}'::text[]`))
    .addColumn('digest_status', 'varchar(16)', (col) => col.notNull().defaultTo('none'))
    .execute();
  await sql`
    ALTER TABLE artifacts
      ADD CONSTRAINT artifacts_digest_status
        CHECK (digest_status IN ('none', 'pending', 'running', 'done', 'failed'))
  `.execute(db);
  await sql`ALTER TABLE artifacts ADD COLUMN search_vector tsvector`.execute(db);
  await sql`CREATE INDEX idx_artifacts_search ON artifacts USING GIN (search_vector)`.execute(db);
  await sql`
    UPDATE artifacts SET digest_status = 'pending'
     WHERE extract_status = 'done' AND extracted_text IS NOT NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_artifacts_search`.execute(db);
  await sql`ALTER TABLE artifacts DROP COLUMN search_vector`.execute(db);
  await sql`ALTER TABLE artifacts DROP CONSTRAINT artifacts_digest_status`.execute(db);
  await db.schema
    .alterTable('artifacts')
    .dropColumn('summary')
    .dropColumn('keywords')
    .dropColumn('digest_status')
    .execute();
}
