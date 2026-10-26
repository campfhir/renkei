import { Kysely, sql } from 'kysely';

/**
 * OCR timings for an artifact, so the library can say how far along a
 * scan is and roughly how long it has left (apps/web/lib/chat/artifact-ocr.ts).
 *
 *   - `ocr_started_at`: set while a run is in flight, cleared when it ends.
 *     A run whose start is older than the stale window is treated as dead.
 *   - `ocr_finished_at`, `ocr_millis`, `ocr_pages`: written by a run that
 *     succeeded. `ocr_millis` is what the estimate is built from: the median
 *     of finished runs of similar size, org-wide, timings only and never text.
 *
 * The Mistral connector answers one call per file, so there is no page-by-page
 * progress to store. The partial index covers the estimate's one query, which
 * reads the most recent finished runs.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('artifacts')
    .addColumn('ocr_started_at', 'timestamptz')
    .addColumn('ocr_finished_at', 'timestamptz')
    .addColumn('ocr_pages', 'integer')
    .addColumn('ocr_millis', 'integer')
    .execute();
  await sql`
    CREATE INDEX artifacts_ocr_finished_idx
      ON artifacts (ocr_finished_at DESC)
      WHERE ocr_millis IS NOT NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS artifacts_ocr_finished_idx`.execute(db);
  await db.schema
    .alterTable('artifacts')
    .dropColumn('ocr_millis')
    .dropColumn('ocr_pages')
    .dropColumn('ocr_finished_at')
    .dropColumn('ocr_started_at')
    .execute();
}
