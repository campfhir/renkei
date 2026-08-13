import { Kysely, sql } from 'kysely';

/**
 * The SOURCE document's own date on every knowledge chunk, so retrieval can
 * answer "mail from last week" rather than "rows ingested last week".
 *
 * `created_at` cannot serve this: it is ingest time, and `ingestChunk`'s
 * upsert deliberately does not refresh it, so a re-ingested item reports
 * whenever Renkei first happened to see it. For a mailbox backfilled in one
 * pass that timestamp is identical across years of mail — useless as a
 * filter and quietly wrong rather than obviously wrong.
 *
 * Nullable on purpose: not every connector has a meaningful document date
 * (and the backfill below cannot invent one), so a NULL means "undated",
 * which a date filter must treat as excluded rather than as epoch.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('knowledge_chunks').addColumn('source_at', 'timestamptz').execute();

  // Backfill from where each connector already recorded the date: microsoft
  // writes `when`, zoom `startTime`, webex `created`. These are free-text
  // jsonb values, so the cast is guarded — a malformed one becomes NULL
  // (undated) instead of aborting the whole migration. Postgres has no
  // try_cast, hence the regex pre-filter for an ISO-8601-looking prefix.
  await sql`
    UPDATE knowledge_chunks
       SET source_at = (
             COALESCE(
               metadata ->> 'when',
               metadata ->> 'startTime',
               metadata ->> 'created'
             )
           )::timestamptz
     WHERE source_at IS NULL
       AND COALESCE(
             metadata ->> 'when',
             metadata ->> 'startTime',
             metadata ->> 'created'
           ) ~ '^\\d{4}-\\d{2}-\\d{2}'
  `.execute(db);

  // Retrieval filters by tenant and (optionally) provider before ordering by
  // vector distance; source_at trails those so the same index serves an
  // unfiltered provider scan and a dated one.
  await db.schema
    .createIndex('idx_knowledge_chunks_source_at')
    .on('knowledge_chunks')
    .columns(['tenant_id', 'provider', 'source_at'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex('idx_knowledge_chunks_source_at').execute();
  await db.schema.alterTable('knowledge_chunks').dropColumn('source_at').execute();
}
