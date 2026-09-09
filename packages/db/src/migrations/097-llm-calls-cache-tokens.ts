import { Kysely } from 'kysely';

/**
 * Prompt-cache tokens on the token ledger.
 *
 * Providers bill a cached prompt prefix differently from a fresh one —
 * a read from the cache at a fraction of the input price, a write to it
 * at a premium — and both adapters have reported the two counts since
 * they learned to cache (`LlmUsage.cacheReadInputTokens` /
 * `cacheWriteInputTokens`). The ledger folded them away, so a chat that
 * re-sends the same long prefix every turn looked as expensive as one
 * that did not. Two more integers, content-free like the rest.
 *
 * `input_tokens` keeps its meaning as the UNCACHED prompt tokens, which
 * is what Anthropic reports as `input_tokens`; the OpenAI adapter now
 * subtracts its `cached_tokens` (a subset of `prompt_tokens` there) so
 * the three columns add up the same way whichever provider wrote them.
 * Zero on rows written before this migration — there is nothing to
 * backfill them from.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('llm_calls')
    .addColumn('cache_read_input_tokens', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('cache_write_input_tokens', 'integer', (col) => col.notNull().defaultTo(0))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('llm_calls')
    .dropColumn('cache_read_input_tokens')
    .dropColumn('cache_write_input_tokens')
    .execute();
}
