import { Kysely, sql } from 'kysely';

/**
 * The agent-run queue: third queue table pair, same shape as 013/030
 * (Decision #20's pattern, third application).
 *
 * Agent runs are LLM loops — minutes of network time per message — and the
 * same reasoning that moved embedding work out of the interactive queue
 * applies with more force here: this work gets its own table, consumed by
 * its own horizontally scalable process (apps/worker-agents), so a slow
 * model can never sit in front of a webhook reply.
 *
 * Payloads are bare { runId } pointers — all run state lives in agent_runs /
 * agent_run_steps, which is what makes lease-reclaim a RESUME rather than a
 * restart. Producers set ordering_key 'agent:{agentId}', so one agent's
 * runs stay strictly serial (an email burst cannot race an agent against
 * itself and double-act on an external system) while different agents drain
 * in parallel across any number of consumer instances.
 *
 * The consumer config (packages/queue agentJobsQueue) stretches the claim
 * lease to 30 minutes — a legitimate run can hold a claim far longer than
 * the default 10 — and trims the attempt budget to 3: retries here mean
 * "the engine crashed", not "the step failed"; step-level retries are the
 * engine's own, counted in agent_run_steps.
 */

const TABLE = 'agent_jobs';

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
    /** The original enqueue time — preserved so a requeue restores order. */
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
