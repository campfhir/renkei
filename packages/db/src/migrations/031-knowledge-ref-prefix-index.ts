import { Kysely, sql } from 'kysely';

/**
 * An index for prefix matching on `knowledge_chunks.ref_id`.
 *
 * Two hot paths match a refId prefix rather than an exact value, and both
 * grew load-bearing with drive ingestion:
 *
 *   - Change detection reads the stored metadata of a whole delta round in
 *     one query (`readObjectMetadataBatch`), and a chunked document has no
 *     row at its bare refId — only `${refId}#0001` and friends — so the
 *     lookup has to be a LIKE.
 *   - The disconnect purge and per-object delete both match `${refId}%`.
 *
 * The existing unique index on (tenant_id, provider, ref_id) does NOT serve
 * these: under any non-C collation, btree comparison order does not match
 * byte-prefix order, so Postgres cannot use it for a LIKE prefix scan.
 * `text_pattern_ops` builds the ordering that can, which turns a sequential
 * scan of every chunk in the tenant into an index range read on the one
 * query that runs for every document of every sync round.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE INDEX idx_knowledge_chunks_ref_prefix
      ON knowledge_chunks (tenant_id, provider, ref_id text_pattern_ops)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_knowledge_chunks_ref_prefix`.execute(db);
}
