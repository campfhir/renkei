/**
 * Sandbox file metadata, through the data store (`sandboxFiles`). Bytes
 * never pass through here — see server.ts for the disk side — this is
 * purely the `sandbox_files` row:
 * insert on stage, list/get/delete by (tenantId, subject), and the sweep's
 * expiry walk. Every function takes tenantId + subject explicitly and
 * filters on both, the same no-cross-caller-reads discipline upload_slots
 * and the fileshare store already keep.
 *
 * A staged file may additionally carry a `batchId` (packages/db/src/migrations/075-*):
 * still scoped by (tenantId, subject) for every read, but quota is checked
 * against a SEPARATE pool keyed by (tenantId, batchId) when one is given —
 * `totalStagedBytesForBatch`/`countFilesForBatch` — so a document-ocr-pipeline
 * batch staging thousands of pages is never measured against, or crowds out,
 * the same person's ordinary interactive scratch space.
 */

import { randomUUID } from 'node:crypto';
import { getDataStore, type SandboxFileRecord } from '@renkei/db';
import type { SandboxFileSummary } from '@renkei/connector-sandbox';

export interface SandboxTarget {
  subject: string;
}

export interface StageFileInput extends SandboxTarget {
  filename: string;
  contentType: string | null;
  sizeBytes: number;
  storageKey: string;
  source: string;
  batchId: string | null;
  expiresAt: Date;
}

function toSummary(record: SandboxFileRecord): SandboxFileSummary {
  return {
    id: record.id,
    filename: record.filename,
    contentType: record.contentType,
    sizeBytes: record.sizeBytes,
    source: record.source,
    batchId: record.batchId,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  };
}

export interface StoredFile {
  id: string;
  filename: string;
  contentType: string | null;
  storageKey: string;
}

function toStored(record: SandboxFileRecord): StoredFile {
  return {
    id: record.id,
    filename: record.filename,
    contentType: record.contentType,
    storageKey: record.storageKey,
  };
}

export async function insertFile(input: StageFileInput): Promise<SandboxFileSummary> {
  const record = await getDataStore().sandboxFiles.insert({
    id: randomUUID(),
    subject: input.subject,
    filename: input.filename,
    contentType: input.contentType,
    sizeBytes: input.sizeBytes,
    storageKey: input.storageKey,
    source: input.source,
    batchId: input.batchId,
    expiresAt: input.expiresAt,
  });
  return toSummary(record);
}

export async function listFiles(
  target: SandboxTarget,
  batchId?: string
): Promise<SandboxFileSummary[]> {
  return (await getDataStore().sandboxFiles.list(target.subject, batchId)).map(toSummary);
}

/** Current total staged bytes for a caller — the quota check reads this before staging a new file. */
export async function totalStagedBytes(target: SandboxTarget): Promise<number> {
  return getDataStore().sandboxFiles.totalBytesForSubject(target.subject);
}

export async function countFiles(target: SandboxTarget): Promise<number> {
  return getDataStore().sandboxFiles.countForSubject(target.subject);
}

/**
 * The batch quota pool: totals for a batch rather than the caller's whole
 * scratch space. A batch is not subject-scoped — its owning subject already
 * governs every row's read access, so the quota pool doesn't need to repeat
 * that filter.
 */
export async function totalStagedBytesForBatch(batchId: string): Promise<number> {
  return getDataStore().sandboxFiles.totalBytesForBatch(batchId);
}

export async function countFilesForBatch(batchId: string): Promise<number> {
  return getDataStore().sandboxFiles.countForBatch(batchId);
}

export async function getFile(
  target: SandboxTarget,
  fileId: string
): Promise<StoredFile | undefined> {
  const record = await getDataStore().sandboxFiles.get(target.subject, fileId);
  return record ? toStored(record) : undefined;
}

export async function deleteFile(
  target: SandboxTarget,
  fileId: string
): Promise<StoredFile | undefined> {
  const record = await getDataStore().sandboxFiles.delete(target.subject, fileId);
  return record ? toStored(record) : undefined;
}

/** Rows past their expiry — the sweep deletes each one's bytes, then this row. */
export async function listExpired(limit: number): Promise<(StoredFile & { expiresAt: Date })[]> {
  const records = await getDataStore().sandboxFiles.listExpired(new Date(), limit);
  return records.map((record) => ({ ...toStored(record), expiresAt: record.expiresAt }));
}

export async function deleteById(id: string): Promise<void> {
  await getDataStore().sandboxFiles.deleteById(id);
}
