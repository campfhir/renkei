/**
 * The lexical index entry (ingest.ts's `searchTextParts`) as a Kysely SQL
 * fragment, for the writers that still update `knowledge_chunks` with
 * their own queries — the embedding worker's reindex sweep
 * (reindex.ts) — rather than through the data store, whose
 * knowledgeChunks.upsert builds the same expression itself.
 */

import { sql, type RawBuilder } from 'kysely';
import { searchTextParts } from './ingest';

/** `to_tsvector(config, text)` — the config rides as a bound parameter cast to regconfig. */
function tsvector(config: string, text: string): RawBuilder<string> {
  return sql<string>`to_tsvector(${config}::regconfig, ${text})`;
}

/** Title at weight A, keywords at B, chunk text at C (see searchTextParts). */
export function searchTextFragment(
  title: string,
  keywords: readonly string[] | null | undefined,
  content: string
): RawBuilder<string> {
  const parts = searchTextParts(title, keywords, content);
  return sql<string>`setweight(${tsvector(parts.config, parts.title)}, 'A') || setweight(${tsvector(parts.config, parts.keywords)}, 'B') || setweight(${tsvector(parts.config, parts.content)}, 'C')`;
}
