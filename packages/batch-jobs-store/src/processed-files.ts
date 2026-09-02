/**
 * The ledger of files a batch has already processed — `batch_processed_files`
 * (migration 089). What makes "don't do the same file twice" deterministic:
 * a file's identity is the SHA-256 of its bytes, scoped to (tenant, share),
 * and whether it was processed is a row lookup, never a judgement.
 *
 * Two lookups, one ledger:
 *
 *  - `findProcessedByPath` is discovery's fast path. A listing already
 *    carries path, size and modified time, so a file whose triple matches
 *    what was recorded when it was hashed is skipped without being read.
 *    `matchesProcessedStat` is that comparison, kept pure and exported so
 *    the rule is testable on its own.
 *  - `findProcessedHashes` is the item-time check, after the bytes were
 *    read (they had to be, for OCR) and hashed, and BEFORE anything billed
 *    happens. A re-copied or renamed file misses the fast path and lands
 *    here.
 *
 * `recordProcessedFiles` upserts on the hash, rewriting the path/size/
 * modified triple, so the fast path follows a file that moved. Callers
 * that opted out of the ledger (`skipProcessed: false`) call none of these.
 */

import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { DB } from '@renkei/db';

export interface ProcessedFileRow {
  contentHash: string;
  path: string;
  size: number;
  modifiedAt: Date | null;
}

export interface ProcessedFileInput {
  contentHash: string;
  path: string;
  size: number;
  modifiedAt: Date | null;
  documentKey?: string;
}

/** Postgres `IN` lists are fine at thousands; chunk so a giant folder still is. */
const CHUNK = 1_000;

function chunks<T>(values: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += CHUNK) out.push(values.slice(i, i + CHUNK));
  return out;
}

/** The ledger rows recorded at any of these paths, on this share. */
export async function findProcessedByPath(
  db: Kysely<DB>,
  tenantId: string,
  shareId: string,
  paths: string[]
): Promise<Map<string, ProcessedFileRow>> {
  const found = new Map<string, ProcessedFileRow>();
  for (const chunk of chunks(paths)) {
    if (chunk.length === 0) continue;
    const rows = await db
      .selectFrom('batch_processed_files')
      .select(['content_hash', 'path', 'size', 'modified_at'])
      .where('tenant_id', '=', tenantId)
      .where('share_id', '=', shareId)
      .where('path', 'in', chunk)
      .execute();
    for (const row of rows) {
      found.set(row.path, {
        contentHash: row.content_hash,
        path: row.path,
        size: row.size,
        modifiedAt: row.modified_at ? new Date(row.modified_at) : null,
      });
    }
  }
  return found;
}

/** Which of these content hashes the ledger already holds for this share. */
export async function findProcessedHashes(
  db: Kysely<DB>,
  tenantId: string,
  shareId: string,
  hashes: string[]
): Promise<Set<string>> {
  const known = new Set<string>();
  for (const chunk of chunks([...new Set(hashes)])) {
    if (chunk.length === 0) continue;
    const rows = await db
      .selectFrom('batch_processed_files')
      .select('content_hash')
      .where('tenant_id', '=', tenantId)
      .where('share_id', '=', shareId)
      .where('content_hash', 'in', chunk)
      .execute();
    for (const row of rows) known.add(row.content_hash);
  }
  return known;
}

/**
 * Does a listed file look like the one the ledger recorded at this path?
 * Both size and modified time must match — and a listing with no modified
 * time cannot be matched at all, so it goes on to be read and hashed. The
 * failure direction is deliberate: an unsure fast path must fall through
 * to the hash, never skip on a guess.
 */
export function matchesProcessedStat(
  recorded: ProcessedFileRow,
  listed: { size: number | null; modifiedAt: string | Date | null }
): boolean {
  if (listed.size === null || listed.modifiedAt === null) return false;
  if (recorded.modifiedAt === null) return false;
  if (recorded.size !== listed.size) return false;
  const listedAt =
    listed.modifiedAt instanceof Date ? listed.modifiedAt : new Date(listed.modifiedAt);
  if (Number.isNaN(listedAt.getTime())) return false;
  return listedAt.getTime() === recorded.modifiedAt.getTime();
}

/** Record files as processed — one row per file, upserted on the hash. */
export async function recordProcessedFiles(
  db: Kysely<DB>,
  tenantId: string,
  shareId: string,
  batchId: string,
  files: ProcessedFileInput[]
): Promise<void> {
  if (files.length === 0) return;
  await db
    .insertInto('batch_processed_files')
    .values(
      files.map((file) => ({
        id: randomUUID(),
        tenant_id: tenantId,
        share_id: shareId,
        content_hash: file.contentHash,
        path: file.path,
        size: file.size,
        modified_at: file.modifiedAt,
        batch_id: batchId,
        document_key: file.documentKey ?? null,
      }))
    )
    .onConflict((oc) =>
      oc.columns(['tenant_id', 'share_id', 'content_hash']).doUpdateSet({
        path: sql`excluded.path`,
        size: sql`excluded.size`,
        modified_at: sql`excluded.modified_at`,
        batch_id: sql`excluded.batch_id`,
        document_key: sql`excluded.document_key`,
        processed_at: sql`NOW()`,
      })
    )
    .execute();
}
