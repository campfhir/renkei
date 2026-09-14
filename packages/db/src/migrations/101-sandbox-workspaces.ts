import { Kysely, sql } from 'kysely';

/**
 * Sandbox code workspaces and the environment secrets their commands run
 * with (docs/sandbox-workspaces-design.md).
 *
 * `sandbox_workspaces` is one row per repository a person cloned into the
 * sandbox worker — the metadata half of a checkout whose bytes live on the
 * worker's own workspace volume under `storage_key` (built from ids and a
 * hashed subject, never from the repository name). `repo_full_name` and
 * `branch` are what the person and the model refer to it by; `status`
 * says whether the clone finished (`cloning` → `ready` | `failed`, with
 * `error` for the last case); `size_bytes` is refreshed after work that
 * can grow it. Rows carry an `expires_at` the worker's sweep enforces,
 * extended on use, the same lifetime discipline as sandbox_files — a
 * checkout is working state, not a source of truth. Scoped by
 * (tenant_id, subject): a workspace belongs to the person who cloned it,
 * and every agent run of theirs works in the same one.
 *
 * `sandbox_env_secrets` holds the variables (`NPM_TOKEN`, `API_BASE_URL`,
 * ...) a person hands their workspace commands. `sealed` is a
 * TOKEN_ENCRYPTION_KEY-style envelope, but sealed and opened ONLY by
 * apps/worker-sandbox (under SANDBOX_ENV_SECRETS_KEY, falling back to the
 * deployment key): the value passes through the web app once, on the way
 * in, and is never read back by anything but the worker at exec time — the
 * model sees names, never values, and every value is scrubbed from every
 * output the worker returns. One name per person, matching how a shell
 * sees an environment.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('sandbox_workspaces')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('subject', 'varchar(255)', (col) => col.notNull())
    .addColumn('provider', 'varchar(32)', (col) => col.notNull())
    .addColumn('repo_full_name', 'varchar(255)', (col) => col.notNull())
    .addColumn('branch', 'varchar(255)', (col) => col.notNull())
    .addColumn('storage_key', 'text', (col) => col.notNull())
    .addColumn('status', 'varchar(16)', (col) => col.notNull().defaultTo('cloning'))
    .addColumn('error', 'text')
    .addColumn('size_bytes', 'bigint', (col) => col.notNull().defaultTo(0))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('last_used_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('expires_at', 'timestamptz', (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex('idx_sandbox_workspaces_owner')
    .on('sandbox_workspaces')
    .columns(['tenant_id', 'subject', 'created_at'])
    .execute();

  // The sweep walks by expiry.
  await db.schema
    .createIndex('idx_sandbox_workspaces_expiry')
    .on('sandbox_workspaces')
    .column('expires_at')
    .execute();

  await db.schema
    .createTable('sandbox_env_secrets')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('subject', 'varchar(255)', (col) => col.notNull())
    .addColumn('name', 'varchar(64)', (col) => col.notNull())
    .addColumn('sealed', 'text', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('last_used_at', 'timestamptz')
    .execute();

  // One name per person: a shell environment has one value per variable.
  await db.schema
    .createIndex('idx_sandbox_env_secrets_owner_name')
    .on('sandbox_env_secrets')
    .columns(['tenant_id', 'subject', 'name'])
    .unique()
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('sandbox_env_secrets').execute();
  await db.schema.dropTable('sandbox_workspaces').execute();
}
