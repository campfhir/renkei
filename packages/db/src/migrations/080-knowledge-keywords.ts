import { Kysely, sql } from 'kysely';

/**
 * `knowledge_chunks.keywords`: the search terms and phrases the org's
 * default model extracted from the object at ingest (packages/knowledge/
 * src/keywords.ts). Every chunk of one object carries the same list.
 *
 * They feed the lexical index at weight B — above the body, which moves
 * to C, below the title at A — so a document ranks for what it is about
 * even where its text never says so plainly. Stored as plain text[] rather
 * than only folded into the tsvector because a result card shows them,
 * and a reindex must be able to rebuild the tsvector without a second
 * model call.
 *
 * Same at-rest trade-off as 079's tsvector, one notch further: phrases
 * are legible where lexemes were only suggestive. Nullable: NULL means
 * "not extracted yet" (pre-080 rows, or enrichment off when the row was
 * written) and is what the reindex sweep (`pnpm reindex --keywords`)
 * looks for; an empty array means extraction ran and found nothing worth
 * indexing, and is left alone.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('knowledge_chunks')
    .addColumn('keywords', sql`text[]`)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('knowledge_chunks').dropColumn('keywords').execute();
}
