import { Kysely } from 'kysely';

/**
 * A nullable batch tag on staged sandbox files, for the batch-jobs pipeline
 * (starting with document-ocr-pipeline): every file a batch stages carries
 * its batch_id, so a later stage can ask "everything for batch X" instead
 * of walking the caller's whole scratch space, and so the worker can apply
 * a separate, much larger quota/TTL pool for batch-tagged files than the
 * one interactive scratch space gets (packages/connector-sandbox/src/limits.ts).
 * Rows remain scoped by (tenant_id, subject) as before — batch_id narrows
 * within that scope, it does not replace it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('sandbox_files').addColumn('batch_id', 'uuid').execute();

  await db.schema
    .createIndex('idx_sandbox_files_batch')
    .on('sandbox_files')
    .columns(['tenant_id', 'batch_id'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex('idx_sandbox_files_batch').execute();
  await db.schema.alterTable('sandbox_files').dropColumn('batch_id').execute();
}
