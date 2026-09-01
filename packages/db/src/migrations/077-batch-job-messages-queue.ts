import { Kysely, sql } from 'kysely';

/**
 * The batch-job item queue: fourth queue table pair, same shape as
 * 013/030/036 (Decision #20's pattern, extended again).
 *
 * Each message is a bare pointer at one unit of work — {batchJobId} for a
 * 'discover' message (one per batch: lists the source, applies the
 * batch's grouping strategy, creates batch_job_items rows, enqueues one
 * 'ocr-item' message per item), or {batchJobId, itemId} for an 'ocr-item'
 * message (one per document group). All real state lives in batch_jobs /
 * batch_job_items — the agent_jobs rule — so a lease reclaim after a
 * crash resumes cleanly rather than double-acting.
 *
 * This gets its own table rather than reusing the events queue because an
 * OCR call is slow, external, per-item network I/O — exactly the reasoning
 * that moved embedding work off the interactive queue (030), except here
 * the fan-out is per ITEM rather than per batch, so a job with thousands
 * of documents scales across any number of consumer instances instead of
 * running as one long handler invocation. Producers tag the source
 * 'batch:{batchJobId}' (packages/queue's fairAcrossSources), so one huge
 * batch cannot starve a smaller concurrent one — the embedding_jobs
 * provider-lane precedent.
 */
const TABLE = 'batch_job_messages';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable(TABLE)
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('tenant_id', 'uuid', (col) => col.notNull().references('tenants.id'))
    .addColumn('source', 'varchar(255)', (col) => col.notNull())
    .addColumn('type', 'varchar(255)', (col) => col.notNull())
    .addColumn('payload', 'jsonb', (col) => col.notNull())
    .addColumn('ordering_key', 'varchar(255)')
    .addColumn('status', 'varchar(32)', (col) => col.notNull().defaultTo('pending'))
    .addColumn('attempts', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('run_after', 'timestamp', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('locked_at', 'timestamp')
    .addColumn('last_error', 'text')
    .addColumn('created_at', 'timestamp', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamp', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();

  await db.schema.createIndex(`idx_${TABLE}_tenant_id`).on(TABLE).column('tenant_id').execute();

  await db.schema
    .createIndex(`idx_${TABLE}_claim`)
    .on(TABLE)
    .columns(['status', 'run_after', 'created_at'])
    .execute();

  await sql`
    CREATE INDEX ${sql.raw(`idx_${TABLE}_ordering`)} ON ${sql.raw(TABLE)}
      (ordering_key, status, created_at) WHERE ordering_key IS NOT NULL
  `.execute(db);

  await db.schema
    .createTable(`${TABLE}_dead_letters`)
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('tenant_id', 'uuid', (col) => col.notNull().references('tenants.id'))
    .addColumn('source', 'varchar(255)', (col) => col.notNull())
    .addColumn('type', 'varchar(255)', (col) => col.notNull())
    .addColumn('payload', 'jsonb', (col) => col.notNull())
    .addColumn('ordering_key', 'varchar(255)')
    .addColumn('attempts', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('last_error', 'text')
    .addColumn('created_at', 'timestamp', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('dead_at', 'timestamp', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();

  await db.schema
    .createIndex(`idx_${TABLE}_dead_letters_dead_at`)
    .on(`${TABLE}_dead_letters`)
    .column('dead_at')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable(`${TABLE}_dead_letters`).execute();
  await db.schema.dropTable(TABLE).execute();
}
