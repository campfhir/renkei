import { Kysely } from 'kysely';

/**
 * One row per MCP tool invocation — usage and latency telemetry.
 *
 * WHAT IS DELIBERATELY ABSENT IS THE POINT. There is no arguments column, no
 * result column, no message text. Who called which tool, when, and whether it
 * worked is operational data an org needs to run the thing; what was said to
 * it is the user's. Adding an arguments column later would silently convert
 * a usage table into a surveillance one, and every argument here is content —
 * the JQL someone searched, the person they mailed, the document they opened.
 * The split is: identity and outcome are attributed, content is not recorded
 * at all.
 *
 * Separate from `platform_audit_log`, which is deployment-scoped (it has no
 * tenant column), event-shaped, and low volume. This is per-tenant, hot, and
 * queried by time bucket — different table, different indexes, different
 * retention.
 *
 * Retention: this grows with usage rather than with the org, so it is the
 * first table that will need pruning. Nothing prunes it yet; when that lands,
 * the rows are safe to delete wholesale — no other table references them and
 * nothing is derived from them that is not recomputable.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('tool_calls')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('tenant_id', 'uuid', (col) => col.notNull().references('tenants.id'))
    // The OIDC subject: usage is attributed on purpose, so an org can see who
    // leans on what. The identity spine maps this to a name for display.
    .addColumn('subject', 'varchar(255)')
    .addColumn('tool', 'varchar(128)', (col) => col.notNull())
    // Denormalised from the tool name so "which connector do people use" does
    // not need a LIKE over every row.
    .addColumn('connector', 'varchar(64)')
    // 'ok' | 'error' — whether the tool reported failure, not whether the
    // transport succeeded.
    .addColumn('status', 'varchar(16)', (col) => col.notNull())
    .addColumn('started_at', 'timestamptz', (col) => col.notNull())
    .addColumn('ended_at', 'timestamptz', (col) => col.notNull())
    // Stored rather than computed on read: every latency query needs it, and
    // an expression index would cost the same space with more ceremony.
    .addColumn('duration_ms', 'integer', (col) => col.notNull())
    .execute();

  // The shape every chart asks for: a tenant's calls over a window.
  await db.schema
    .createIndex('idx_tool_calls_tenant_time')
    .on('tool_calls')
    .columns(['tenant_id', 'started_at'])
    .execute();

  // A user's own usage — the non-admin view, which must not scan the tenant.
  await db.schema
    .createIndex('idx_tool_calls_subject_time')
    .on('tool_calls')
    .columns(['tenant_id', 'subject', 'started_at'])
    .execute();

  // Per-tool rollups and the latency view.
  await db.schema
    .createIndex('idx_tool_calls_tool_time')
    .on('tool_calls')
    .columns(['tenant_id', 'tool', 'started_at'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('tool_calls').execute();
}
