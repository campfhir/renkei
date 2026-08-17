import { Kysely, sql } from 'kysely';

/**
 * Tenant-scoped audit trail of PLATFORM actions — who signed in, who
 * connected or disconnected a connector, who created or disabled an agent.
 *
 * Distinct from both of its neighbours on purpose:
 *  - `platform_audit_log` (001) is deployment-scoped — no tenant column —
 *    and belongs to whoever runs the installation, not to an org operator.
 *  - `tool_calls` (032) is usage telemetry: high-volume, per-call, pruned.
 * This table is low-volume and event-shaped: a row is written when a person
 * changes what the platform IS for them (their access, their automations),
 * never when they merely use it. Tool invocations, searches and reads do
 * not belong here — that boundary is what keeps an audit page readable and
 * keeps this from growing into activity surveillance.
 *
 * `action` is a stable dotted verb ('connector.connected', 'user.signed_in');
 * `target_kind`/`target_label` name what was acted on in words a person
 * recognises ('connector'/'microsoft', 'agent'/'Triage inbound mail').
 * `details` carries small structured extras (e.g. { byAdmin: true }) — never
 * content, never tokens.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('audit_events')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    // OIDC subject of who did it; null when the platform itself acted.
    .addColumn('actor_subject', 'varchar(255)')
    .addColumn('action', 'varchar(64)', (col) => col.notNull())
    .addColumn('target_kind', 'varchar(32)')
    .addColumn('target_label', 'varchar(200)')
    .addColumn('details', 'jsonb')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  // The only read shape: a tenant's trail, newest first.
  await db.schema
    .createIndex('idx_audit_events_tenant_time')
    .on('audit_events')
    .columns(['tenant_id', 'created_at'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('audit_events').execute();
}
