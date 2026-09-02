import { Kysely, sql } from 'kysely';

/**
 * An optimization pass over one agent, as a job with a durable result —
 * the same lifecycle shape as `agent_drafts` (058), for the same reasons:
 * the model call takes minutes, nobody should have to keep a tab open for
 * it, and the answer has to survive a reload.
 *
 * The pass reads the agent's captured failures (079), its recent runs'
 * step-level token spend and tool calls, and the definition itself, then
 * asks the org's model for a report: what is going wrong and why, what is
 * costing tokens it need not, and a concrete revision brief. The report
 * is stored here; when the owner chooses to act on it, the brief becomes
 * an ordinary revision draft the builder already knows how to offer — the
 * optimizer never edits an agent by itself.
 *
 * `request` records what the pass looked at (the window, how many
 * failures and runs were in evidence, the steps_version analyzed) so a
 * report can be read against the agent as it was, not as it is now.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('agent_optimizations')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('agent_id', 'uuid', (col) =>
      col.notNull().references('agents.id').onDelete('cascade')
    )
    // Whose pass it is: the report reads run content only the owner may
    // see, and the resulting draft is built with the owner's tool catalog.
    .addColumn('owner_subject', 'varchar(255)', (col) => col.notNull())
    .addColumn('status', 'varchar(32)', (col) => col.notNull().defaultTo('queued'))
    .addColumn('request', 'jsonb', (col) => col.notNull())
    .addColumn('result', 'jsonb')
    .addColumn('error', 'text')
    .addColumn('error_detail', 'text')
    .addColumn('attempts', 'integer', (col) => col.notNull().defaultTo(0))
    // What the pass itself cost, so "optimizing" is a number on the same
    // usage page it exists to improve.
    .addColumn('input_tokens', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('output_tokens', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('finished_at', 'timestamptz')
    // When the owner turned the report into a revision draft (the draft's
    // id rides in `result.draftId`); null while the report just sits.
    .addColumn('applied_at', 'timestamptz')
    .execute();

  // "The newest pass for this agent" is the only question the page asks.
  await db.schema
    .createIndex('idx_agent_optimizations_agent')
    .on('agent_optimizations')
    .columns(['tenant_id', 'agent_id', 'created_at'])
    .execute();

  await db.schema
    .createIndex('idx_agent_optimizations_age')
    .on('agent_optimizations')
    .column('created_at')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('agent_optimizations').execute();
}
