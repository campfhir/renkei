/**
 * Chunking for source objects too large to embed as one row (email bodies,
 * meeting transcripts). A multi-chunk object keeps ONE logical refId; the
 * stored rows carry `${refId}#0001`-style suffixes so the existing unique
 * (tenant_id, provider, ref_id) index still applies per chunk, and the ACL
 * gate keeps working because verifiers derive ownership from the refId
 * prefix, which the suffix never disturbs.
 *
 * Re-ingesting an object deletes its stale rows first: a shrunken object
 * must not leave orphaned high-index chunks behind, and an object that
 * shrank to a single chunk must not leave suffixed leftovers beside the
 * bare-refId row.
 */

import { sql } from 'kysely';
import { getDatabase } from '@renkei/db';
import { ok, err, wrapAsync } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { ingestChunk } from './ingest';
import type { KnowledgeChunkInput } from './ingest';
import type { EmbeddingProvider } from './embeddings';

export interface ChunkTextOptions {
  /** Hard per-chunk ceiling in characters. */
  maxChars?: number;
  /** Trailing context carried into the next chunk. */
  overlap?: number;
}

const DEFAULT_MAX_CHARS = 2_000;
const DEFAULT_OVERLAP = 200;

/**
 * Split text into chunks of at most maxChars, preferring paragraph breaks,
 * then line breaks, then whitespace, so chunks end at natural boundaries
 * when one exists in the second half of the window. Character-based on
 * purpose: no tokenizer dependency, and embedding providers are org
 * configuration so no single tokenizer would be right anyway.
 */
export function chunkText(text: string, options: ChunkTextOptions = {}): string[] {
  const maxChars = Math.max(1, options.maxChars ?? DEFAULT_MAX_CHARS);
  const overlap = Math.min(Math.max(0, options.overlap ?? DEFAULT_OVERLAP), maxChars - 1);

  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= maxChars) return [trimmed];

  const chunks: string[] = [];
  let start = 0;
  while (start < trimmed.length) {
    let end = Math.min(start + maxChars, trimmed.length);
    if (end < trimmed.length) {
      const window = trimmed.slice(start, end);
      const breakAt = preferredBreak(window);
      if (breakAt > 0) end = start + breakAt;
    }
    const piece = trimmed.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= trimmed.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}

/** Best break position inside the window, only if it falls in the second half. */
function preferredBreak(window: string): number {
  const half = Math.floor(window.length / 2);
  for (const pattern of ['\n\n', '\n', ' ']) {
    const at = window.lastIndexOf(pattern);
    if (at > half) return at + pattern.length;
  }
  return 0;
}

/** `refId` for chunk `index` (1-based) of `total`. Single-chunk objects keep the bare refId. */
export function chunkRefId(refId: string, index: number, total: number): string {
  if (total <= 1) return refId;
  return `${refId}#${String(index).padStart(4, '0')}`;
}

/**
 * Delete every stored chunk of one logical object (bare refId plus all
 * `#`-suffixed rows). Also the disconnect-purge helper when called with a
 * broader prefix (e.g. everything under `${upn}/`): pass `prefixOnly` to
 * skip the exact-match arm and treat refId purely as a prefix.
 */
export async function deleteObjectChunks(
  tenantId: string,
  provider: string,
  refId: string,
  options: { prefixOnly?: boolean } = {}
): Promise<Result<void, 'DB_ERROR'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);

  const pattern = options.prefixOnly ? `${escapeLike(refId)}%` : `${escapeLike(refId)}#%`;
  const result = await wrapAsync(
    () =>
      dbResult.val
        .deleteFrom('knowledge_chunks')
        .where('tenant_id', '=', tenantId)
        .where('provider', '=', provider)
        .where((eb) =>
          options.prefixOnly
            ? eb('ref_id', 'like', pattern)
            : eb.or([eb('ref_id', '=', refId), eb('ref_id', 'like', pattern)])
        )
        .execute(),
    'DB_ERROR' as const
  );
  if (!result.ok) return result;
  return ok();
}

/**
 * Delete every chunk a connector tagged with `metadata[key] = value` — the
 * scope-shaped counterpart to deleteObjectChunks.
 *
 * Atlassian refIds are issue keys and page ids with no scope in them, so a
 * ref-id prefix cannot express "everything from project ENG". The poller
 * records the scope in metadata precisely so purging a watch is possible
 * without re-listing the whole project from the provider.
 */
export async function deleteChunksByMetadata(
  tenantId: string,
  provider: string,
  key: string,
  value: string
): Promise<Result<number, 'DB_ERROR'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);

  const result = await wrapAsync(
    () =>
      dbResult.val
        .deleteFrom('knowledge_chunks')
        .where('tenant_id', '=', tenantId)
        .where('provider', '=', provider)
        .where(sql<boolean>`metadata ->> ${key} = ${value}`)
        .executeTakeFirst(),
    'DB_ERROR' as const
  );
  if (!result.ok) return result;
  return ok(Number(result.val.numDeletedRows ?? 0));
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Ingest one source object, chunking when it exceeds the chunk ceiling.
 * Stale rows are deleted first so re-ingest is an exact replacement. Each
 * chunk's metadata carries `chunk`/`chunkCount` so hits can say where in
 * the object they came from.
 */
export async function ingestObjectChunks(
  tenantId: string,
  embedder: EmbeddingProvider,
  object: KnowledgeChunkInput,
  options: ChunkTextOptions = {}
): Promise<Result<{ chunks: number }, 'EMBEDDING_FAILED' | 'DB_ERROR'>> {
  const pieces = chunkText(object.content, options);

  const cleared = await deleteObjectChunks(tenantId, object.provider, object.refId);
  if (!cleared.ok) return cleared;
  if (pieces.length === 0) return ok({ chunks: 0 });

  for (const [index, content] of pieces.entries()) {
    const ingested = await ingestChunk(tenantId, embedder, {
      provider: object.provider,
      refId: chunkRefId(object.refId, index + 1, pieces.length),
      content,
      metadata:
        pieces.length > 1
          ? { ...object.metadata, chunk: index + 1, chunkCount: pieces.length }
          : object.metadata,
      // Every chunk of one document shares the document's date, so a date
      // filter can't return some chunks of an item and hide the rest.
      sourceAt: object.sourceAt,
    });
    if (!ingested.ok) return ingested;
  }
  return ok({ chunks: pieces.length });
}
