import { Kysely, sql } from 'kysely';

/**
 * A lexical index beside the vector one: `knowledge_chunks.search_text`,
 * a weighted tsvector (title at A, chunk text at B) the ingest path builds
 * from each chunk's plaintext, and a GIN index to query it.
 *
 * Dense retrieval alone is weakest exactly where people are most precise:
 * a ticket key, a file name, a person's name, an error string. An
 * embedding of "ENG-787" sits nowhere near the embedding of the ticket it
 * names. Retrieval now runs both arms and fuses their rankings
 * (reciprocal rank fusion, see packages/knowledge/src/index.ts), so an
 * exact token match can surface a chunk the vector would have ranked
 * fortieth.
 *
 * THE AT-REST TRADE-OFF, stated plainly: `content` is ciphertext, and this
 * column is derived from its plaintext. A tsvector is a bag of stemmed
 * lexemes with positions, not the text — sentences cannot be read back
 * out of it — but it does reveal which words a chunk contains, to anyone
 * with the database and without the content key. That is the price of a
 * lexical index the database can use, and the alternative (no lexical arm)
 * was judged the worse retrieval. Everything else that made the encrypted
 * column safe still holds: the ACL gate verifies every candidate live
 * before anything is disclosed, and this column is never returned to a
 * caller.
 *
 * Nullable: rows indexed before this migration have no lexical entry until
 * they are re-ingested or the reindex script (packages/knowledge/scripts/
 * reindex.ts) backfills them. A NULL simply never matches the lexical arm;
 * the vector arm still proposes the row as before.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('knowledge_chunks')
    .addColumn('search_text', sql`tsvector`)
    .execute();

  await sql`
    CREATE INDEX idx_knowledge_chunks_search_text
      ON knowledge_chunks USING gin (search_text)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_knowledge_chunks_search_text`.execute(db);
  await db.schema.alterTable('knowledge_chunks').dropColumn('search_text').execute();
}
