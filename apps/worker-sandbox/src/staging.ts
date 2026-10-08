/**
 * Staging bytes this process holds into the scratch space — the quota,
 * cap and TTL every staged file is held to, in one place, so a fetched
 * URL, a written body, a browser screenshot and a file a script wrote
 * all land under exactly the same rules (docs/sandbox-connector-design.md,
 * "Why this is a bigger decision than it looks"). server.ts uses the
 * headroom and expiry halves inline on its streaming paths; scripts.ts
 * uses `stageBytes` for the files a run leaves in `out/`.
 */

import { Readable } from 'node:stream';
import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import {
  DEFAULT_BATCH_FILE_TTL_MS,
  DEFAULT_BATCH_QUOTA_BYTES,
  DEFAULT_FILE_TTL_MS,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_SUBJECT_QUOTA_BYTES,
  MAX_FILES_PER_BATCH,
  MAX_FILES_PER_SUBJECT,
  type SandboxFileSummary,
} from '@renkei/connector-sandbox';
import * as disk from './disk';
import * as store from './store';

/**
 * How much more this caller may stage right now, after their file-count
 * ceiling — 0 (or less) means "refuse outright," which the caller checks
 * before doing any I/O. A batchId switches to the SEPARATE, much larger
 * batch pool (packages/connector-sandbox/src/limits.ts) keyed by
 * (tenantId, batchId) instead of the interactive per-subject one, so a
 * document-ocr-pipeline batch never competes with the same person's
 * ordinary scratch space.
 */
export async function quotaHeadroom(
  db: Kysely<DB>,
  target: store.SandboxTarget,
  batchId: string | null
): Promise<{ ok: true; remaining: number } | { ok: false; reason: 'too_many_files' }> {
  if (batchId) {
    const count = await store.countFilesForBatch(db, target.tenantId, batchId);
    if (count >= MAX_FILES_PER_BATCH) return { ok: false, reason: 'too_many_files' };
    const total = await store.totalStagedBytesForBatch(db, target.tenantId, batchId);
    return { ok: true, remaining: Math.max(0, DEFAULT_BATCH_QUOTA_BYTES - total) };
  }
  const count = await store.countFiles(db, target);
  if (count >= MAX_FILES_PER_SUBJECT) return { ok: false, reason: 'too_many_files' };
  const total = await store.totalStagedBytes(db, target);
  return { ok: true, remaining: Math.max(0, DEFAULT_SUBJECT_QUOTA_BYTES - total) };
}

export function expiryFromNow(batchId: string | null): Date {
  const ttl = batchId ? DEFAULT_BATCH_FILE_TTL_MS : DEFAULT_FILE_TTL_MS;
  return new Date(Date.now() + ttl);
}

export type StageRefusal =
  | { ok: false; reason: 'too_many_files' }
  | { ok: false; reason: 'quota_full' }
  | { ok: false; reason: 'too_large'; cap: number };

/**
 * Stage bytes already in hand under the caller's interactive quota: the
 * file-count ceiling, the remaining bytes, and the per-file cap (the
 * org's attachment limit, never above the sandbox's own). `sizeBytes` is
 * checked before `bytes` is read so an oversized file is refused without
 * being loaded.
 */
export async function stageBytes(
  db: Kysely<DB>,
  target: store.SandboxTarget,
  input: { filename: string; contentType: string | null; source: string; sizeBytes: number },
  bytes: () => Promise<Buffer>,
  tenantMaxFileBytes: number
): Promise<{ ok: true; file: SandboxFileSummary } | StageRefusal> {
  const headroom = await quotaHeadroom(db, target, null);
  if (!headroom.ok) return { ok: false, reason: 'too_many_files' };
  if (headroom.remaining <= 0) return { ok: false, reason: 'quota_full' };
  const cap = Math.min(tenantMaxFileBytes, DEFAULT_MAX_FILE_BYTES, headroom.remaining);
  if (input.sizeBytes > cap) return { ok: false, reason: 'too_large', cap };
  const storageKey = disk.newStorageKey(target.tenantId, target.subject);
  const written = await disk.writeStream(storageKey, Readable.from([await bytes()]), cap);
  if (!written.ok) return { ok: false, reason: 'too_large', cap };
  const file = await store.insertFile(db, {
    ...target,
    filename: input.filename,
    contentType: input.contentType,
    sizeBytes: written.sizeBytes,
    storageKey,
    source: input.source,
    batchId: null,
    expiresAt: expiryFromNow(null),
  });
  return { ok: true, file };
}
