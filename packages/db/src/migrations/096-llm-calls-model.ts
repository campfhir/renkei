import { Kysely, sql } from 'kysely';

/**
 * Which model a token-ledger row was spent on.
 *
 * `llm_calls` (085) has counted tokens per call since it existed, but
 * never said WHAT they were spent on: a million input tokens on a small
 * model and a million on a frontier one were the same two integers. The
 * run recorded its model-config id (`agent_runs.llm_model_id`), but runs
 * are pruned by run retention while the ledger lives on, and a config row
 * can be re-pointed at a different model at any time — so the ledger has
 * to carry the provider and model NAME as they were at the moment of the
 * call, the way a chat message already does (092). Every writer has the
 * resolved model in hand when it records spend: the engine (per attempt),
 * the chat's turn store, and the optimizer's pass.
 *
 * `llm_model_id` is a soft reference to the config row that answered —
 * no foreign key, so deleting a config does not touch the ledger and the
 * name columns keep telling the truth after the row is gone. Null on
 * every column for rows written before this migration, except where the
 * backfill below can still resolve them.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('llm_calls')
    .addColumn('llm_model_id', 'uuid')
    .addColumn('provider', 'varchar(32)')
    .addColumn('model', 'varchar(128)')
    .execute();

  // Run rows whose run is still within retention name their config row;
  // the config's CURRENT model is the best available guess for what
  // answered — an operator who re-pointed the row since will see the new
  // name on old spend, which is why the live writers record the name
  // rather than the id. Chat and optimizer rows have no such link.
  await sql`
    UPDATE llm_calls c
    SET llm_model_id = m.id, provider = m.provider, model = m.model
    FROM agent_runs r
    JOIN llm_model_configs m ON m.id = r.llm_model_id
    WHERE c.run_id = r.id AND c.model IS NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('llm_calls')
    .dropColumn('llm_model_id')
    .dropColumn('provider')
    .dropColumn('model')
    .execute();
}
