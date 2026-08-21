import { Kysely, sql } from 'kysely';

/**
 * Durable per-day run tallies, one row per (tenant, agent, day).
 *
 * `agent_runs` cannot answer "how many times has this agent run this
 * year": run rows carry content (tool previews, resolved instructions) and
 * are pruned by the org's retention policy, so counting them only reaches
 * back as far as retention does. These counters carry NO content — a date
 * and an integer — so they can be kept forever, which is what makes the
 * overview's quarterly/yearly/all-time numbers and cap accounting honest.
 *
 * Incremented in createAgentRun (the one path every trigger kind goes
 * through); backfilled below from whatever run rows retention has not yet
 * pruned, so the page starts with history instead of zeros.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('agent_run_counters')
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('agent_id', 'uuid', (col) => col.notNull())
    .addColumn('day', 'date', (col) => col.notNull())
    .addColumn('runs', 'integer', (col) => col.notNull().defaultTo(0))
    .addPrimaryKeyConstraint('pk_agent_run_counters', ['tenant_id', 'agent_id', 'day'])
    .execute();

  await sql`
    INSERT INTO agent_run_counters (tenant_id, agent_id, day, runs)
    SELECT tenant_id, agent_id, created_at::date, COUNT(*)
    FROM agent_runs
    GROUP BY tenant_id, agent_id, created_at::date
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('agent_run_counters').execute();
}
