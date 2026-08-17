import { Kysely, sql } from 'kysely';

/**
 * Per-agent memory — what an agent carries between runs, so run N+1 can
 * know what run N already did ("I already replied to message X") instead
 * of each run waking up amnesiac.
 *
 * Two kinds of row, one table:
 *  - 'entry': an append-only note. Written by the engine — automatically
 *    at run end (status + the trigger identifiers, the dedupe breadcrumb)
 *    and explicitly when a step's finish_step carries `remember`.
 *  - 'summary': at most ONE row per agent (partial unique index) — the
 *    rolling compaction of old entries, rewritten by the memory-compaction
 *    sweep using the agent's own LLM.
 *
 * Context safety is a READ-time guarantee, not a table property: the
 * engine injects at most a fixed character budget (summary first, then
 * newest entries), so a lagging compaction can never blow up a prompt —
 * it only degrades how far back the verbatim tail reaches.
 *
 * `run_id` is provenance only (which run wrote this); SET NULL because the
 * retention sweep prunes old runs and memory deliberately outlives them.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('agent_memories')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('agent_id', 'uuid', (col) =>
      col.notNull().references('agents.id').onDelete('cascade')
    )
    .addColumn('kind', 'varchar(16)', (col) => col.notNull().defaultTo('entry'))
    .addColumn('content', 'text', (col) => col.notNull())
    .addColumn('run_id', 'uuid', (col) => col.references('agent_runs.id').onDelete('set null'))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  // The read shape: one agent's memory, newest first, entries and summary
  // told apart by kind.
  await db.schema
    .createIndex('idx_agent_memories_agent')
    .on('agent_memories')
    .columns(['tenant_id', 'agent_id', 'kind', 'created_at'])
    .execute();

  // One rolling summary per agent — compaction rewrites it, never adds a
  // second.
  await sql`
    CREATE UNIQUE INDEX idx_agent_memories_summary
    ON agent_memories (agent_id)
    WHERE kind = 'summary'
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('agent_memories').execute();
}
