import { Kysely, sql } from 'kysely';

/**
 * The org's model roster for user-drafted agents (bring-your-own LLM,
 * Decision #8: the platform hosts no models — it holds credentials to
 * someone else's).
 *
 * A table rather than a `connector_configs` row (the embeddings precedent)
 * because the org holds a LIST of models — several providers, several keys —
 * and agents reference a specific one by id. A jsonb array in one row would
 * lose referential integrity (deleting a model would silently orphan the
 * agents pinned to it) and make per-model key rotation a read-modify-write
 * over everyone's secrets at once.
 *
 * `encrypted_secrets` is a secretbox-sealed JSON blob ({ apiKey }) under
 * TOKEN_ENCRYPTION_KEY, same as connector_configs. `settings` holds the
 * inspectable knobs (maxOutputTokens, temperature).
 *
 * At most one row per tenant carries `is_default` — enforced by a partial
 * unique index, not application code, because two defaults is not a state
 * an agent run can resolve.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('llm_model_configs')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('tenant_id', 'uuid', (col) => col.notNull().references('tenants.id'))
    .addColumn('label', 'varchar(128)', (col) => col.notNull())
    // 'anthropic' first; 'openai' / 'gemini' adapters slot in later.
    .addColumn('provider', 'varchar(32)', (col) => col.notNull())
    .addColumn('model', 'varchar(128)', (col) => col.notNull())
    // Optional override for proxies / gateway fronts; adapters supply the
    // provider's canonical URL when null.
    .addColumn('base_url', 'text')
    .addColumn('settings', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('encrypted_secrets', 'text', (col) => col.notNull())
    .addColumn('enabled', 'boolean', (col) => col.notNull().defaultTo(true))
    .addColumn('is_default', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addUniqueConstraint('llm_model_configs_tenant_label', ['tenant_id', 'label'])
    .execute();

  await sql`
    CREATE UNIQUE INDEX idx_llm_model_configs_default
      ON llm_model_configs (tenant_id) WHERE is_default
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('llm_model_configs').execute();
}
