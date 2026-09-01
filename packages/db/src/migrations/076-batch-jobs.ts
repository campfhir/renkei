import { Kysely, sql } from 'kysely';

/**
 * The generic batch-job framework: a batch runs some kind-dispatched work
 * over many items, tracked with progress counters (the mail_bulk_jobs
 * shape, migration 046) — but unlike mail_bulk_jobs, which executes its
 * whole job in one queue delivery, a batch's ITEMS are each their own
 * queue message on batch_job_messages (migration 077), fanned out across
 * any number of worker instances. `batch_jobs` is the job-level read model
 * (status, totals); `batch_job_items` is the per-unit-of-work read model
 * (status, kind-specific payload/result) each item's message points at.
 *
 * `kind` picks the handler the same way `upload_slots.kind` does
 * (apps/web/lib/upload-executors.ts's dispatch-by-kind) — the first kind is
 * 'document-ocr-pipeline'; a future batch job type is a new handler
 * registered against a new kind, no schema change.
 *
 * `subject` is the owning identity: the sandbox files a batch stages are
 * scoped to this subject (packages/db/src/migrations/075-*), and it is
 * what the status tools scope every lookup by — the same discipline every
 * other job-row table here already keeps.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('batch_jobs')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('subject', 'varchar(255)', (col) => col.notNull())
    .addColumn('kind', 'varchar(64)', (col) => col.notNull())
    // Kind-specific parameters — for document-ocr-pipeline: {shareId, path,
    // grouping: {strategy: 'whole-file'|'filename-pattern', pattern?}, ...}.
    .addColumn('config', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
    // 'queued' | 'discovering' | 'running' | 'succeeded' | 'partial' | 'failed' | 'canceled'
    .addColumn('status', 'varchar(16)', (col) => col.notNull().defaultTo('queued'))
    // Null until discovery finishes populating batch_job_items.
    .addColumn('total', 'integer')
    .addColumn('succeeded', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('failed', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('last_error', 'text')
    .addColumn('started_at', 'timestamptz')
    .addColumn('finished_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();

  await db.schema
    .createIndex('idx_batch_jobs_owner_time')
    .on('batch_jobs')
    .columns(['tenant_id', 'subject', 'created_at'])
    .execute();

  // Live work only: the same idx_agent_runs_live / idx_mail_bulk_jobs_live idiom.
  await sql`
    CREATE INDEX idx_batch_jobs_live ON batch_jobs (tenant_id, status)
      WHERE status IN ('queued', 'discovering', 'running')
  `.execute(db);

  await db.schema
    .createTable('batch_job_items')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('batch_id', 'uuid', (col) =>
      col.notNull().references('batch_jobs.id').onDelete('cascade')
    )
    // 'pending' | 'processing' | 'succeeded' | 'failed'
    .addColumn('status', 'varchar(16)', (col) => col.notNull().defaultTo('pending'))
    // Kind-specific input — for document-ocr-pipeline: {sourcePaths: [...],
    // documentKey}, one entry per file in the group in page order.
    .addColumn('payload', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
    // Kind-specific output once processed — for document-ocr-pipeline:
    // {sandboxFileId, pageCount}.
    .addColumn('result', 'jsonb')
    .addColumn('error', 'text')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();

  await db.schema
    .createIndex('idx_batch_job_items_batch_status')
    .on('batch_job_items')
    .columns(['batch_id', 'status'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('batch_job_items').execute();
  await db.schema.dropTable('batch_jobs').execute();
}
