import { Kysely, sql } from 'kysely';

/**
 * User-drafted agents and their triggers (RENKEI.md Phase 5's workflow
 * builder, arriving early).
 *
 * An agent is a user's saved recipe: ordered steps in `steps` jsonb (an
 * AgentStepsDoc — see packages/agents), each step one instruction with at
 * most ONE tool, a total-attempt budget hard-capped at 5 (validated on
 * save AND re-counted from run records at execution — the snapshot is never
 * trusted alone), and per-failure-condition handling. The document format
 * is versioned (`steps.version`) so the shape can evolve without a table
 * rewrite; `steps_version` counts saves so run records can say which
 * revision they executed.
 *
 * `owner_subject` is the OIDC subject whose provider grants runs act under
 * (Decision #2's execute-as-the-approver precedent: no service accounts).
 * `description` is LLM-generated on save — advisory, never blocking, which
 * is why `description_status` exists instead of a NOT NULL constraint.
 *
 * Triggers are rows, not jsonb-in-agent, because two of the four kinds are
 * looked up by something other than the agent: schedules by `next_run_at`
 * (the content_watches per-row-due-time pattern) and connector events by
 * `(tenant_id, event_source, event_type)` — both served by partial indexes
 * below rather than jsonb scans. `config` holds the kind-specific rest
 * (recurrence, match filters, API key hash, caller agent id).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('agents')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('tenant_id', 'uuid', (col) => col.notNull().references('tenants.id'))
    .addColumn('owner_subject', 'varchar(255)', (col) => col.notNull())
    .addColumn('name', 'varchar(200)', (col) => col.notNull())
    .addColumn('description', 'text')
    // 'ok' | 'stale' | 'failed' — whether `description` reflects the current
    // steps. A save that cannot reach the org's model still saves.
    .addColumn('description_status', 'varchar(16)', (col) => col.notNull().defaultTo('stale'))
    // The spot-check findings from description generation (unreachable
    // steps, contradictory outcomes) — advisory only, shown to the owner.
    .addColumn('review_notes', 'jsonb')
    .addColumn('steps', 'jsonb', (col) => col.notNull())
    .addColumn('steps_version', 'integer', (col) => col.notNull().defaultTo(1))
    // NULL = the org's default model. SET NULL on delete: losing a model
    // config must not strand the agents pinned to it.
    .addColumn('llm_model_id', 'uuid', (col) =>
      col.references('llm_model_configs.id').onDelete('set null')
    )
    // Agents are born disabled; enabling requires at least one trigger.
    .addColumn('enabled', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addUniqueConstraint('agents_tenant_name', ['tenant_id', 'name'])
    .execute();

  await db.schema
    .createIndex('idx_agents_owner')
    .on('agents')
    .columns(['tenant_id', 'owner_subject'])
    .execute();

  await db.schema
    .createTable('agent_triggers')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('tenant_id', 'uuid', (col) => col.notNull().references('tenants.id'))
    .addColumn('agent_id', 'uuid', (col) =>
      col.notNull().references('agents.id').onDelete('cascade')
    )
    // 'event' | 'schedule' | 'agent' | 'api'
    .addColumn('kind', 'varchar(16)', (col) => col.notNull())
    // Denormalized from config for kind='event' so webhook-time fan-out is
    // one indexed lookup, never a jsonb scan of every trigger in the tenant.
    .addColumn('event_source', 'varchar(64)')
    .addColumn('event_type', 'varchar(64)')
    .addColumn('config', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('enabled', 'boolean', (col) => col.notNull().defaultTo(true))
    // kind='schedule' only: when this trigger next fires. Advanced with an
    // optimistic UPDATE ... WHERE next_run_at = observed, so N sweep
    // instances never double-fire.
    .addColumn('next_run_at', 'timestamptz')
    .addColumn('last_fired_at', 'timestamptz')
    // The content_watches pattern: a trigger that cannot fire says why on
    // its own row (cycle refused, depth exceeded, daily cap hit).
    .addColumn('last_error', 'text')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();

  await db.schema
    .createIndex('idx_agent_triggers_agent')
    .on('agent_triggers')
    .columns(['tenant_id', 'agent_id'])
    .execute();

  await sql`
    CREATE INDEX idx_agent_triggers_due ON agent_triggers (next_run_at)
      WHERE kind = 'schedule' AND enabled
  `.execute(db);

  await sql`
    CREATE INDEX idx_agent_triggers_event ON agent_triggers (tenant_id, event_source, event_type)
      WHERE kind = 'event' AND enabled
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('agent_triggers').execute();
  await db.schema.dropTable('agents').execute();
}
