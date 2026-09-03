import { Kysely, sql } from 'kysely';

/**
 * Sandbox browser secrets: credentials an agent's sandbox browser may type
 * but the model may never see (docs/sandbox-connector-design.md, "Secrets").
 *
 * `sealed` is NOT a TOKEN_ENCRYPTION_KEY envelope. It is sealed under a key
 * derived from a passphrase Renkei generated, showed the person once, and
 * does not store (packages/connector-sandbox/src/secrets.ts, the `sbx1.`
 * prefix) — so this table plus the deployment key yields nothing. The
 * derived key lives only in apps/worker-sandbox's memory while the secret
 * is unlocked, which is why there is no `unlocked_until` column here: the
 * worker is the source of truth for that, and a restart locks everything.
 *
 * `field_names` and `hosts` are the non-secret half a listing shows: which
 * fields exist (username, password, ...) and which hostnames the worker
 * will type them into — never the values. Every row is scoped by
 * (tenant_id, subject), and carries an `expires_at` the worker's sweep
 * enforces, like sandbox_files.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('sandbox_secrets')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('subject', 'varchar(255)', (col) => col.notNull())
    .addColumn('name', 'varchar(64)', (col) => col.notNull())
    .addColumn('field_names', 'jsonb', (col) => col.notNull())
    .addColumn('hosts', 'jsonb', (col) => col.notNull())
    .addColumn('sealed', 'text', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('expires_at', 'timestamptz', (col) => col.notNull())
    .addColumn('last_used_at', 'timestamptz')
    .execute();

  // One name per person: the model refers to a secret by name.
  await db.schema
    .createIndex('idx_sandbox_secrets_owner_name')
    .on('sandbox_secrets')
    .columns(['tenant_id', 'subject', 'name'])
    .unique()
    .execute();

  // The sweep walks by expiry.
  await db.schema
    .createIndex('idx_sandbox_secrets_expiry')
    .on('sandbox_secrets')
    .column('expires_at')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('sandbox_secrets').execute();
}
