/**
 * Near-duplicate detection via embedding cosine similarity — a semantic
 * extension of `log.ts`'s exact-hash dedup, for recurring automated
 * notifications that repeat almost verbatim (a timestamp differs, a name or
 * a file differs) but are never byte-for-byte identical, so the hash check
 * alone misses them.
 *
 * Reads `knowledge_chunks` directly with a raw SQL query — the same
 * cosine-distance shape `@renkei/knowledge`'s own `searchKnowledge` uses —
 * rather than importing `@renkei/knowledge` as a search API, because this
 * isn't a retrieval query with an ACL gate to satisfy: it's an internal
 * "have we already embedded something almost exactly like this" check
 * scoped to the tenant that produced both sides, no cross-user disclosure
 * question involved.
 */

import { sql } from 'kysely';
import { getDatabase } from '@renkei/db';
import { ok, err, wrapAsync } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';

/** pgvector cosine distance ≤ this counts as a near-duplicate (0.02 ⇒ ≥98% cosine similarity). */
export const NEAR_DUPLICATE_MAX_DISTANCE = 0.02;

/** How far back to look for a near-duplicate — bounds the scan, mirrors the exact-hash dedup window. */
const NEAR_DUPLICATE_LOOKBACK_DAYS = 30;

export interface NearDuplicateScope {
  /**
   * The message's own ref id. Its own chunks are excluded from the scan —
   * without that, re-processing an already-indexed message finds itself at
   * distance 0, calls itself a duplicate, and DELETES the chunk. A re-index
   * pass then empties the mail index one message at a time, every step
   * reporting success.
   */
  refId: string;
  /**
   * Namespace to compare within, as a ref-id prefix ('alice@x.com/msg/').
   * Comparing tenant-wide meant one person's mail could be suppressed by a
   * colleague's similar mail, and — once calendar shells were in the index
   * — by content from an entirely different connector.
   */
  refIdPrefix: string;
}

/**
 * Whether some OTHER already-indexed chunk in the same namespace is a
 * near-duplicate of the given embedding vector. `vector` is a pgvector
 * literal (see `@renkei/knowledge`'s `vectorLiteral`).
 */
export async function hasNearDuplicateChunk(
  tenantId: string,
  vector: string,
  scope: NearDuplicateScope
): Promise<Result<boolean, 'DB_ERROR'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);

  const result = await wrapAsync(
    () =>
      sql<{ distance: number }>`
        SELECT (embedding <=> ${vector}::vector) AS distance
        FROM knowledge_chunks
        WHERE tenant_id = ${tenantId}
          AND ref_id LIKE ${`${scope.refIdPrefix}%`}
          AND ref_id <> ${scope.refId}
          AND ref_id NOT LIKE ${`${scope.refId}#%`}
          AND created_at >= NOW() - ${NEAR_DUPLICATE_LOOKBACK_DAYS} * INTERVAL '1 day'
        ORDER BY distance
        LIMIT 1
      `.execute(dbResult.val),
    'DB_ERROR' as const
  );
  if (!result.ok) return result;

  const distance = result.val.rows[0]?.distance;
  return ok(typeof distance === 'number' && distance <= NEAR_DUPLICATE_MAX_DISTANCE);
}
