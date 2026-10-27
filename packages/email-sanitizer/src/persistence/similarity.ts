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

import { getDataStore } from '@renkei/db';
import { ok, wrapAsync } from '@campfhir/safe-functions/helpers';
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
 * near-duplicate of the given embedding vector.
 */
export async function hasNearDuplicateChunk(
  vector: readonly number[],
  scope: NearDuplicateScope
): Promise<Result<boolean, 'DB_ERROR'>> {
  const result = await wrapAsync(
    () =>
      getDataStore().knowledgeChunks.nearestDistance(vector, {
        refIdPrefix: scope.refIdPrefix,
        excludeRefId: scope.refId,
        since: new Date(Date.now() - NEAR_DUPLICATE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000),
      }),
    'DB_ERROR' as const
  );
  if (!result.ok) return result;

  const distance = result.val;
  return ok(distance !== null && distance <= NEAR_DUPLICATE_MAX_DISTANCE);
}
