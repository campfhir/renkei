import { Kysely, sql } from 'kysely';

/**
 * Artifact bulk jobs: what the library's select toolbar asks for over many
 * files at once (delete, run OCR, add to a project), done on the server so
 * nobody has to keep the page open while it works through them
 * (apps/web/lib/chat/artifact-bulk-job.ts).
 *
 * The row is the queue, the jira/salesforce apply-job way: the route writes
 * it 'queued' and starts the job in after(); a sweep on every web process
 * starts a queued row whose process went away, and takes over a 'running'
 * row whose job stopped touching it. Unlike an apply job, a taken-over job
 * carries on: every act it does is safe to repeat (a deleted file is not
 * found, an attached file is attached again with the same mode, a file
 * being read is refused), so it resumes with the files `results` has no
 * answer for yet.
 *
 *   - `subject`: who asked; every act runs as them, and only they read it.
 *   - `action`: 'delete' | 'ocr' | 'attach'; `project_id` and `mode` for
 *     'attach' only.
 *   - `artifact_ids`: the files, in the order ticked.
 *   - `results`: [{ id, filename, error }] in the order answered, one per
 *     file done; `error` null when it went through.
 *   - `status`: 'queued' | 'running' | 'done' | 'partial' | 'failed'.
 *   - `dismissed_at`: the library stops showing it; set at the end when
 *     nothing failed, or when the person closes the failure line.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('artifact_bulk_jobs')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('subject', 'varchar(255)', (col) => col.notNull())
    .addColumn('action', 'varchar(16)', (col) => col.notNull())
    .addColumn('project_id', 'uuid')
    .addColumn('mode', 'varchar(16)')
    .addColumn('artifact_ids', 'jsonb', (col) => col.notNull())
    .addColumn('results', 'jsonb', (col) => col.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn('status', 'varchar(16)', (col) => col.notNull().defaultTo('queued'))
    .addColumn('last_error', 'text')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('finished_at', 'timestamptz')
    .addColumn('dismissed_at', 'timestamptz')
    .execute();

  // The library's read: this person's jobs not yet dismissed, newest first.
  await sql`
    CREATE INDEX idx_artifact_bulk_jobs_shown ON artifact_bulk_jobs (subject, created_at DESC)
      WHERE dismissed_at IS NULL
  `.execute(db);

  // Live work only: the sweep's read.
  await sql`
    CREATE INDEX idx_artifact_bulk_jobs_live ON artifact_bulk_jobs (updated_at)
      WHERE status IN ('queued', 'running')
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('artifact_bulk_jobs').execute();
}
