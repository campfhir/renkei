import { Kysely, sql } from 'kysely';

/**
 * The trigger-firing lock ledger: at most ONE agent run per (trigger,
 * source event), no matter how many worker processes are running.
 *
 * The event fan-out used to be an unconditional loop — every matching
 * trigger got a run on every delivery. With multiple worker replicas that
 * duplicated runs three ways: concurrently-swept duplicate webhook
 * registrations (one event, two deliveries), the documented dispatch replay
 * window (bookkeeping write fails after runs were created), and stale-lease
 * re-claims of a slow queue row. All three collapse into the same fix: the
 * fan-out INSERTs a claim here with ON CONFLICT DO NOTHING before creating
 * a run, and only the winner of the primary key proceeds.
 *
 * `dedupe_key` names the source event (`msg:{messageId}` for WebEx/mail,
 * `meeting:{meetingUuid}` for Zoom, `event:{queue row id}` as the
 * fallback), so the lock's granularity is exactly one agent trigger — which
 * already pins the owner and the event source/type — per real-world event.
 * Rows are hygiene, not history: a worker sweep prunes them after 7 days.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('agent_trigger_firings')
    .addColumn('trigger_id', 'uuid', (col) =>
      col.notNull().references('agent_triggers.id').onDelete('cascade')
    )
    .addColumn('dedupe_key', 'varchar(255)', (col) => col.notNull())
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    // The run the claim winner created; null between claim and creation,
    // and stays null if run creation failed and the release also failed.
    .addColumn('run_id', 'uuid')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addPrimaryKeyConstraint('agent_trigger_firings_pkey', ['trigger_id', 'dedupe_key'])
    .execute();

  // The pruning sweep walks by age.
  await db.schema
    .createIndex('idx_agent_trigger_firings_age')
    .on('agent_trigger_firings')
    .column('created_at')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('agent_trigger_firings').execute();
}
