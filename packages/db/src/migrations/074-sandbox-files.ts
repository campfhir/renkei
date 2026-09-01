import { Kysely, sql } from 'kysely';

/**
 * Sandbox files: metadata for the agent scratch space (apps/worker-sandbox).
 * Mirrors upload_slots' shape — metadata only, the bytes themselves live on
 * the worker's own disk under `storage_key`, never in this table. Every row
 * is scoped by (tenant_id, subject): no cross-caller reads, the same
 * discipline upload_slots and file-share connections already keep.
 *
 * `source` records provenance for display/audit ("fetch:example.com",
 * "fileshare:<shareId>", "write") — never a full URL, credential, or path,
 * which could leak into logs or a listing.
 *
 * This is the first place Renkei deliberately holds file bytes at rest
 * outside a provider or a browser (docs/sandbox-connector-design.md), so
 * every row carries a short, fixed `expires_at` the worker's sweep enforces
 * — nothing here is meant to outlive the task that staged it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('sandbox_files')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('subject', 'varchar(255)', (col) => col.notNull())
    .addColumn('filename', 'varchar(255)', (col) => col.notNull())
    .addColumn('content_type', 'varchar(255)')
    .addColumn('size_bytes', 'integer', (col) => col.notNull())
    // The relative path under the worker's data volume; opaque to every
    // other process — only apps/worker-sandbox ever opens it.
    .addColumn('storage_key', 'varchar(255)', (col) => col.notNull())
    .addColumn('source', 'varchar(255)', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('expires_at', 'timestamptz', (col) => col.notNull())
    .execute();

  // The sweep walks by expiry.
  await db.schema
    .createIndex('idx_sandbox_files_expiry')
    .on('sandbox_files')
    .column('expires_at')
    .execute();

  // sandbox_list_files' shape (and the quota check's sum) — and the tenant
  // + subject scope every operation enforces.
  await db.schema
    .createIndex('idx_sandbox_files_owner_time')
    .on('sandbox_files')
    .columns(['tenant_id', 'subject', 'created_at'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('sandbox_files').execute();
}
