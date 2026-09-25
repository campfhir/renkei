import { Kysely, sql } from 'kysely';

/**
 * A person's standing opt-in to hear about one pull request's pipeline
 * outcome, and — separately opted into — have Renkei act on it:
 * `pr_subscriptions` is the opt-in itself (who, which PR, watch/auto-fix/
 * auto-merge), `pr_pipeline_events` is what arrived and what Renkei did
 * about it, one row per webhook delivery that matched a subscription.
 *
 * This is its own small subsystem, not a repurposing of the `agents`/
 * `agent_runs` tables: those model a generic workflow-builder agent with
 * its own run engine, unrelated to a code chat. A GitHub or Bitbucket
 * webhook (app/api/webhooks/github|bitbucket/[tenantId]/route.ts)
 * enqueues onto the existing webhookEventsQueue; a worker
 * (apps/worker-agents/src/pr-pipeline-events.ts) matches the delivery
 * against `pr_subscriptions`, re-fetches the authoritative state through
 * lib/code/repo-host.ts (never trusting the webhook payload's own
 * conclusion), records the outcome here, and — per that row's own
 * auto_fix/auto_merge — starts a chat turn or merges the PR under the
 * subscriber's own provider_grants token.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('pr_subscriptions')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('project_id', 'uuid', (col) =>
      col.notNull().references('chat_projects.id').onDelete('cascade')
    )
    // The chat that pushed the PR, for routing an opt-in fix back to it.
    // Null'd out (not cascaded) if that chat is later deleted — the
    // subscription and its recorded events stand on their own.
    .addColumn('chat_id', 'uuid', (col) => col.references('chats.id').onDelete('set null'))
    .addColumn('subscriber_subject', 'varchar(255)', (col) => col.notNull())
    .addColumn('provider', 'varchar(40)', (col) =>
      col.notNull().check(sql`provider IN ('github', 'atlassian-bitbucket')`)
    )
    .addColumn('repo_full_name', 'varchar(400)', (col) => col.notNull())
    .addColumn('pr_number', 'integer', (col) => col.notNull())
    .addColumn('watch_pipelines', 'boolean', (col) => col.notNull().defaultTo(true))
    .addColumn('auto_fix', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('auto_merge', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('status', 'varchar(20)', (col) =>
      col
        .notNull()
        .defaultTo('active')
        .check(sql`status IN ('active', 'resolved', 'canceled')`)
    )
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();

  await db.schema
    .createIndex('idx_pr_subscriptions_unique_subscriber')
    .unique()
    .on('pr_subscriptions')
    .columns(['tenant_id', 'provider', 'repo_full_name', 'pr_number', 'subscriber_subject'])
    .execute();

  // The worker's own lookup: an inbound delivery names (tenant, provider,
  // repo, PR) and needs every active subscriber for it, not one.
  await db.schema
    .createIndex('idx_pr_subscriptions_lookup')
    .on('pr_subscriptions')
    .columns(['tenant_id', 'provider', 'repo_full_name', 'pr_number'])
    .where(sql.ref('status'), '=', 'active')
    .execute();

  await db.schema
    .createTable('pr_pipeline_events')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('subscription_id', 'uuid', (col) =>
      col.notNull().references('pr_subscriptions.id').onDelete('cascade')
    )
    .addColumn('provider_run_id', 'varchar(120)', (col) => col.notNull())
    .addColumn('conclusion', 'varchar(20)', (col) => col.notNull())
    .addColumn('raw_payload', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('observed_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('action_taken', 'varchar(20)', (col) =>
      col.check(
        sql`action_taken IN ('fix_started', 'merged', 'fix_failed', 'merge_failed')`
      )
    )
    .execute();

  await db.schema
    .createIndex('idx_pr_pipeline_events_subscription')
    .on('pr_pipeline_events')
    .columns(['subscription_id', 'observed_at'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('pr_pipeline_events').execute();
  await db.schema.dropTable('pr_subscriptions').execute();
}
