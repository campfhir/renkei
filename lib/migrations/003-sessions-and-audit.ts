import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // Session tracking for Jira grant usage
  await db.schema
    .createTable('jira_sessions')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('tenant_id', 'uuid', (col) => col.notNull().references('tenants.id'))
    .addColumn('account_id', 'varchar(255)', (col) => col.notNull())
    .addColumn('user_agent', 'text')
    .addColumn('ip_address', 'varchar(45)')
    .addColumn('last_used_at', 'timestamp', (col) => col.notNull())
    .addColumn('created_at', 'timestamp', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addUniqueConstraint('jira_sessions_unique', ['tenant_id', 'account_id', 'user_agent', 'ip_address'])
    .execute();

  await db.schema.createIndex('idx_jira_sessions_tenant_id').on('jira_sessions').column('tenant_id').execute();
  await db.schema.createIndex('idx_jira_sessions_account_id').on('jira_sessions').column('account_id').execute();
  await db.schema.createIndex('idx_jira_sessions_last_used').on('jira_sessions').column('last_used_at').execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('jira_sessions').execute();
}
