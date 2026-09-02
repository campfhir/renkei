import { Kysely, sql } from 'kysely';

/**
 * Two things a batch job that runs over the same folder night after night
 * needs and did not have:
 *
 * 1. `batch_jobs.skipped` — a third counter beside succeeded/failed. A file
 *    the batch deliberately did not process (because an earlier batch
 *    already did — see below) is neither a success nor a failure, and
 *    counting it as either would make "OCR'd 42 documents" a lie the
 *    second night. Items carry the matching `skipped` status. The batch's
 *    terminal flip counts all three against `total`.
 *
 * 2. `batch_processed_files` — the ledger of files a batch has already
 *    processed, keyed by the SHA-256 of the file's bytes. Deterministic on
 *    purpose: whether a file is "already done" is a hash comparison, never
 *    a judgement a model makes. Scoped to (tenant, share) because the same
 *    bytes on the same share are the same document however they were
 *    named; a different share is a different corpus.
 *
 *    The path/size/modified_at triple beside the hash is the cheap first
 *    look: discovery already has a listing with all three, so a file whose
 *    triple matches the row recorded when it was hashed is skipped without
 *    being read at all. A file whose triple changed (re-copied, renamed) is
 *    read and hashed at item time, and skipped there if the hash is known —
 *    before the billed OCR call, never after. Re-processing rewrites the
 *    triple (ON CONFLICT on the hash), so the fast path follows the file.
 *
 *    A batch may opt out (`config.skipProcessed: false`): it then neither
 *    consults nor writes the ledger — "keep no record" rather than "skip
 *    nothing but record everything", so an opted-out batch cannot make a
 *    later opted-in one skip files it never saw processed.
 *
 *    `batch_id` is a soft reference (SET NULL): the ledger must outlive the
 *    batch that wrote it, or pruning batches would un-process every file.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('batch_jobs')
    .addColumn('skipped', 'integer', (col) => col.notNull().defaultTo(0))
    .execute();

  await db.schema
    .createTable('batch_processed_files')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('share_id', 'uuid', (col) =>
      col.notNull().references('file_shares.id').onDelete('cascade')
    )
    // Lowercase hex SHA-256 of the file's bytes.
    .addColumn('content_hash', 'varchar(64)', (col) => col.notNull())
    // Where the file was when it was hashed — the fast-path fingerprint,
    // not an identity. Size in bytes; transfers are capped well below 2^31.
    .addColumn('path', 'text', (col) => col.notNull())
    .addColumn('size', 'integer', (col) => col.notNull())
    .addColumn('modified_at', 'timestamptz')
    .addColumn('batch_id', 'uuid', (col) => col.references('batch_jobs.id').onDelete('set null'))
    // The logical document the file became part of, for a person reading
    // the ledger; a per-page scan shares one key across its pages.
    .addColumn('document_key', 'text')
    .addColumn('processed_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addUniqueConstraint('batch_processed_files_hash', ['tenant_id', 'share_id', 'content_hash'])
    .execute();

  // Discovery's fast path: every listed path of one share, in one query.
  await db.schema
    .createIndex('idx_batch_processed_files_path')
    .on('batch_processed_files')
    .columns(['tenant_id', 'share_id', 'path'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('batch_processed_files').execute();
  await db.schema.alterTable('batch_jobs').dropColumn('skipped').execute();
}
