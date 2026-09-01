/**
 * Postgres access for sandbox file metadata. Bytes never pass through here —
 * see server.ts for the disk side — this is purely the `sandbox_files` row:
 * insert on stage, list/get/delete by (tenantId, subject), and the sweep's
 * expiry walk. Every function takes tenantId + subject explicitly and
 * filters on both, the same no-cross-caller-reads discipline upload_slots
 * and the fileshare store already keep.
 */

import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import type { SandboxFileSummary } from '@renkei/connector-sandbox';

export interface SandboxTarget {
  tenantId: string;
  subject: string;
}

export interface StageFileInput extends SandboxTarget {
  filename: string;
  contentType: string | null;
  sizeBytes: number;
  storageKey: string;
  source: string;
  expiresAt: Date;
}

function toSummary(row: {
  id: string;
  filename: string;
  content_type: string | null;
  size_bytes: number;
  source: string;
  created_at: Date;
  expires_at: Date;
}): SandboxFileSummary {
  return {
    id: row.id,
    filename: row.filename,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    source: row.source,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export async function insertFile(
  db: Kysely<DB>,
  input: StageFileInput
): Promise<SandboxFileSummary> {
  const row = await db
    .insertInto('sandbox_files')
    .values({
      id: randomUUID(),
      tenant_id: input.tenantId,
      subject: input.subject,
      filename: input.filename,
      content_type: input.contentType,
      size_bytes: input.sizeBytes,
      storage_key: input.storageKey,
      source: input.source,
      expires_at: input.expiresAt,
    })
    .returning(['id', 'filename', 'content_type', 'size_bytes', 'source', 'created_at', 'expires_at'])
    .executeTakeFirstOrThrow();
  return toSummary(row);
}

export async function listFiles(
  db: Kysely<DB>,
  target: SandboxTarget
): Promise<SandboxFileSummary[]> {
  const rows = await db
    .selectFrom('sandbox_files')
    .select(['id', 'filename', 'content_type', 'size_bytes', 'source', 'created_at', 'expires_at'])
    .where('tenant_id', '=', target.tenantId)
    .where('subject', '=', target.subject)
    .orderBy('created_at', 'desc')
    .execute();
  return rows.map(toSummary);
}

/** Current total staged bytes for a caller — the quota check reads this before staging a new file. */
export async function totalStagedBytes(db: Kysely<DB>, target: SandboxTarget): Promise<number> {
  const row = await db
    .selectFrom('sandbox_files')
    .select((eb) => eb.fn.sum<string>('size_bytes').as('total'))
    .where('tenant_id', '=', target.tenantId)
    .where('subject', '=', target.subject)
    .executeTakeFirst();
  return row?.total ? Number(row.total) : 0;
}

export async function countFiles(db: Kysely<DB>, target: SandboxTarget): Promise<number> {
  const row = await db
    .selectFrom('sandbox_files')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('tenant_id', '=', target.tenantId)
    .where('subject', '=', target.subject)
    .executeTakeFirst();
  return row?.count ? Number(row.count) : 0;
}

export interface StoredFile {
  id: string;
  filename: string;
  contentType: string | null;
  storageKey: string;
}

export async function getFile(
  db: Kysely<DB>,
  target: SandboxTarget,
  fileId: string
): Promise<StoredFile | undefined> {
  const row = await db
    .selectFrom('sandbox_files')
    .select(['id', 'filename', 'content_type', 'storage_key'])
    .where('tenant_id', '=', target.tenantId)
    .where('subject', '=', target.subject)
    .where('id', '=', fileId)
    .executeTakeFirst();
  if (!row) return undefined;
  return { id: row.id, filename: row.filename, contentType: row.content_type, storageKey: row.storage_key };
}

export async function deleteFile(
  db: Kysely<DB>,
  target: SandboxTarget,
  fileId: string
): Promise<StoredFile | undefined> {
  const row = await db
    .deleteFrom('sandbox_files')
    .where('tenant_id', '=', target.tenantId)
    .where('subject', '=', target.subject)
    .where('id', '=', fileId)
    .returning(['id', 'filename', 'content_type', 'storage_key'])
    .executeTakeFirst();
  if (!row) return undefined;
  return { id: row.id, filename: row.filename, contentType: row.content_type, storageKey: row.storage_key };
}

/** Rows past their expiry — the sweep deletes each one's bytes, then this row. */
export async function listExpired(db: Kysely<DB>, limit: number): Promise<StoredFile[]> {
  const rows = await db
    .selectFrom('sandbox_files')
    .select(['id', 'filename', 'content_type', 'storage_key'])
    .where('expires_at', '<', new Date())
    .limit(limit)
    .execute();
  return rows.map((row) => ({
    id: row.id,
    filename: row.filename,
    contentType: row.content_type,
    storageKey: row.storage_key,
  }));
}

export async function deleteById(db: Kysely<DB>, id: string): Promise<void> {
  await db.deleteFrom('sandbox_files').where('id', '=', id).execute();
}
