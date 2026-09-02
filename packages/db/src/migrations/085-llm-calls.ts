import { Kysely, sql } from 'kysely';

/**
 * The token ledger: one row per model call, timestamped, attributed to a
 * person — the `tool_calls` table's twin for tokens, and for the same
 * reason (migration 032): a ledger with a real timestamp can be read in
 * any viewer's own day, summed per person, per agent, or per run, and
 * pruned by age, where the per-day counters (072) could only ever be read
 * on the database's calendar.
 *
 * `subject` is whose spend it is — a run's owner, or the person whose
 * optimization pass or draft the call served. `agent_id`/`run_id`/
 * `step_id` say what the call was for when it was a run's; `purpose`
 * names the other callers ('optimize', and whatever follows). Content-
 * free by construction: two integers and some ids.
 *
 * `run_id` and `step_id` are soft references — the run and its attempts
 * are pruned by run retention while this ledger lives on under the org's
 * usage retention.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('llm_calls')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('subject', 'varchar(255)', (col) => col.notNull())
    .addColumn('agent_id', 'uuid', (col) => col.references('agents.id').onDelete('set null'))
    .addColumn('run_id', 'uuid')
    .addColumn('step_id', 'uuid')
    // 'run' (an agent step's model turns), 'optimize' (the optimizer's pass).
    .addColumn('purpose', 'varchar(32)', (col) => col.notNull())
    .addColumn('input_tokens', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('output_tokens', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();

  await db.schema
    .createIndex('idx_llm_calls_subject')
    .on('llm_calls')
    .columns(['tenant_id', 'subject', 'created_at'])
    .execute();

  await sql`
    CREATE INDEX idx_llm_calls_agent ON llm_calls (tenant_id, agent_id, created_at)
      WHERE agent_id IS NOT NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('llm_calls').execute();
}
