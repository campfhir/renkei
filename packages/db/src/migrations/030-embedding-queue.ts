import { Kysely, sql } from 'kysely';

/**
 * The embedding queue, and dead-letter tables for both queues
 * (Decision #20, second revision).
 *
 * Embedding/ingestion work — network calls to an org-configured embeddings
 * endpoint, hundreds of them for a mailbox rebuild — used to run inside the
 * same serial consumer that answers WebEx messages, so one slow endpoint
 * wedged every reply. It moves to its own queue TABLE (`embedding_jobs`),
 * consumed by its own worker process: the workloads differ in payload size,
 * latency profile, retry meaning, and reprocessing needs, which is enough
 * to warrant separate storage rather than a discriminator column.
 *
 * Both queues follow the same shape (@renkei/queue's Postgres adapter):
 *
 *   - `ordering_key`: messages sharing a key are delivered strictly
 *     oldest-first, one at a time, across ANY number of consumer instances
 *     — the Kafka-partition-key analog, enforced in the claim query. This
 *     is what makes horizontal worker scaling safe while purge-before-
 *     re-ingest and delete-after-ingest ordering still hold per mailbox.
 *   - a `*_dead_letters` table per queue: a message that spends its attempt
 *     budget MOVES there (keeping the live claim path lean) and can be
 *     requeued later for reprocessing once the underlying fault is fixed.
 *
 * Existing `events` rows with status='dead' migrate into the new
 * events_dead_letters table; everything else is untouched.
 */

const QUEUE_TABLES = ['events', 'embedding_jobs'] as const;

async function createQueueTable(db: Kysely<unknown>, name: string): Promise<void> {
  await db.schema
    .createTable(name)
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
}

async function createDeadLetterTable(db: Kysely<unknown>, name: string): Promise<void> {
  await db.schema
    .createTable(name)
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('tenant_id', 'uuid', (col) => col.notNull().references('tenants.id'))
    .addColumn('source', 'varchar(255)', (col) => col.notNull())
    .addColumn('type', 'varchar(255)', (col) => col.notNull())
    .addColumn('payload', 'jsonb', (col) => col.notNull())
    .addColumn('ordering_key', 'varchar(255)')
    .addColumn('attempts', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('last_error', 'text')
    /** The original enqueue time — preserved so a requeue restores order. */
    .addColumn('created_at', 'timestamp', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('dead_at', 'timestamp', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();
  await db.schema.createIndex(`idx_${name}_dead_at`).on(name).column('dead_at').execute();
}

async function createQueueIndexes(db: Kysely<unknown>, name: string): Promise<void> {
  // The claim scan: ready work, oldest first. (events already carries this
  // as idx_events_claim from 013 — created here only for new tables.)
  if (name !== 'events') {
    await db.schema
      .createIndex(`idx_${name}_claim`)
      .on(name)
      .columns(['status', 'run_after', 'created_at'])
      .execute();
  }
  // The ordering-key sibling probe in the claim query: "is there an older
  // live message with my key?" Partial — unkeyed messages never probe it.
  await sql`
    CREATE INDEX ${sql.raw(`idx_${name}_ordering`)} ON ${sql.raw(name)}
      (ordering_key, status, created_at) WHERE ordering_key IS NOT NULL
  `.execute(db);
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('events').addColumn('ordering_key', 'varchar(255)').execute();

  await createQueueTable(db, 'embedding_jobs');
  await db.schema
    .createIndex('idx_embedding_jobs_tenant_id')
    .on('embedding_jobs')
    .column('tenant_id')
    .execute();

  for (const table of QUEUE_TABLES) {
    await createQueueIndexes(db, table);
    await createDeadLetterTable(db, `${table}_dead_letters`);
  }

  // Dead rows move out of the live queue — the claim path stops paying for
  // history, and the dead-letter table becomes the reprocessing surface.
  await sql`
    INSERT INTO events_dead_letters
      (id, tenant_id, source, type, payload, ordering_key, attempts, last_error, created_at)
    SELECT id, tenant_id, source, type, payload, ordering_key, attempts, last_error, created_at
    FROM events WHERE status = 'dead'
  `.execute(db);
  await sql`DELETE FROM events WHERE status = 'dead'`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Restore dead rows into the live table before the DLQ disappears.
  await sql`
    INSERT INTO events (id, tenant_id, source, type, payload, status, attempts, last_error, created_at)
    SELECT id, tenant_id, source, type, payload, 'dead', attempts, last_error, created_at
    FROM events_dead_letters
  `.execute(db);
  for (const table of QUEUE_TABLES) {
    await db.schema.dropTable(`${table}_dead_letters`).execute();
  }
  await db.schema.dropTable('embedding_jobs').execute();
  await sql`DROP INDEX IF EXISTS idx_events_ordering`.execute(db);
  await db.schema.alterTable('events').dropColumn('ordering_key').execute();
}
