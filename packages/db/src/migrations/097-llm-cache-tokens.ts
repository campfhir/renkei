import { Kysely, sql } from 'kysely';

/**
 * Where the prompt tokens came from.
 *
 * `input_tokens` on the token ledger (085) and on attempt rows (071) keeps
 * meaning what every usage view reads it as: every prompt token the model
 * read, cache-served or not. Now that the agents engine caches its prompt
 * prefix, these two columns are that number's breakdown — the portion
 * served from the provider's cache (billed at a discount) and the portion
 * written to it (billed at a premium) — so a cost view can price a run
 * without changing what a usage view counts.
 *
 * NULL means not reported: rows written before this migration, and calls
 * through a provider with no cache accounting. 0 means reported, none.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  for (const table of ['llm_calls', 'agent_run_steps']) {
    await sql`ALTER TABLE ${sql.table(table)} ADD COLUMN cache_read_input_tokens integer`.execute(
      db
    );
    await sql`ALTER TABLE ${sql.table(table)} ADD COLUMN cache_write_input_tokens integer`.execute(
      db
    );
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of ['llm_calls', 'agent_run_steps']) {
    await sql`ALTER TABLE ${sql.table(table)} DROP COLUMN cache_read_input_tokens`.execute(db);
    await sql`ALTER TABLE ${sql.table(table)} DROP COLUMN cache_write_input_tokens`.execute(db);
  }
}
