import { Kysely, sql } from 'kysely';

/**
 * Clear the email-ingest jobs left in the embedding queue after mail left
 * the knowledge index (migration 135).
 *
 * Mail is read live through the person's own grant now, but jobs queued
 * before that change stayed in `embedding_jobs`, many from a producer build
 * that predates raw-content encryption: their `raw` is a plain JSON object,
 * which the consumer refuses ("'raw' must be an encrypted string"). Each one
 * spends its five attempts and dies, and because a mailbox's jobs share an
 * ordering key and run one at a time, every dead job just lets the next one
 * in line start failing — a backlog that logs errors all day and never
 * drains anything useful.
 *
 * So: delete every `ingest.email` job, pending or dead-lettered, under the
 * knowledge source (`knowledge`, or its per-provider lane
 * `knowledge:<provider>`). The dead letters go too: they hold whole emails,
 * some in plaintext, and requeueing them would only index mail this build
 * no longer indexes.
 *
 * Irreversible by nature — the content came from the provider and can only
 * be re-read from there, which this build no longer does for the index.
 */
const EMAIL_JOBS = sql`
  type = 'ingest.email'
  AND (source = 'knowledge' OR source LIKE 'knowledge:%')
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`DELETE FROM embedding_jobs WHERE ${EMAIL_JOBS}`.execute(db);
  await sql`DELETE FROM embedding_jobs_dead_letters WHERE ${EMAIL_JOBS}`.execute(db);
}

export async function down(): Promise<void> {
  // Nothing to restore: the rows held provider content this build does not
  // re-ingest. Re-running `up` after a rollback is harmless.
}
