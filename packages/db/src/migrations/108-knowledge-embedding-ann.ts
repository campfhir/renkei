import { Kysely, sql } from 'kysely';

/**
 * ANN index for `knowledge_chunks.embedding` — the follow-up 018 named
 * outright: "an ANN index requires a fixed dimension and can be added when
 * volume demands it." Every semantic search has been doing an exact,
 * unindexed scan — computing cosine distance for every row that survives
 * the WHERE clause before it can even sort — which is the dominant,
 * confirmed cost behind slow `search_knowledge` calls as indexed volume
 * has grown.
 *
 * HNSW needs a fixed dimension, which the `vector` column intentionally
 * does not have (the embedding model, and so its dimension, is org
 * configuration, not schema). This migration reads whatever dimension is
 * actually present in the data instead of hardcoding one, fixes the column
 * to it, and builds the index on that. It refuses to run if more than one
 * dimension is already mixed into the table: that would mean two different
 * embedding models share this column today, which a single fixed dimension
 * cannot support without silently breaking one of them — that needs a
 * deliberate decision, not a migration guessing which model wins.
 *
 * `vector_cosine_ops` to match the `<=>` operator `searchKnowledge` already
 * orders by.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const dims = await sql<{ dims: number }>`
    SELECT DISTINCT vector_dims(embedding) AS dims
    FROM knowledge_chunks
  `.execute(db);

  if (dims.rows.length === 0) {
    // Nothing indexed yet — no dimension to size the index to. Whoever
    // ingests the first chunk after this runs will need this migration's
    // work redone by hand, since a dimension can't be guessed from an
    // empty table.
    return;
  }
  if (dims.rows.length > 1) {
    throw new Error(
      `knowledge_chunks.embedding holds ${dims.rows.length} different vector dimensions ` +
        `(${dims.rows.map((row) => row.dims).join(', ')}); an HNSW index needs one fixed ` +
        'dimension, so this needs a real decision instead of a migration guessing which model wins.'
    );
  }

  const dimension = sql.raw(String(dims.rows[0]!.dims));

  await sql`
    ALTER TABLE knowledge_chunks
      ALTER COLUMN embedding TYPE vector(${dimension})
      USING embedding::vector(${dimension})
  `.execute(db);

  await sql`
    CREATE INDEX idx_knowledge_chunks_embedding_hnsw
      ON knowledge_chunks USING hnsw (embedding vector_cosine_ops)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_knowledge_chunks_embedding_hnsw`.execute(db);
  await sql`
    ALTER TABLE knowledge_chunks
      ALTER COLUMN embedding TYPE vector
      USING embedding::vector
  `.execute(db);
}
