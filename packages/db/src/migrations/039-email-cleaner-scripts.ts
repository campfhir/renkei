import { Kysely, sql } from 'kysely';

/**
 * Admin-authored cleaner scripts for the email sanitizer — small JS
 * functions `(email) => string` run in a QuickJS WebAssembly sandbox as a
 * stage after the built-in cleaners, for boilerplate that literal phrases
 * cannot express.
 *
 * Content-free like the other three config tables (rules, templates,
 * banners): a script is code the admin wrote, never message content. The
 * sandbox is what makes admin-supplied CODE acceptable where admin-supplied
 * REGEX was refused (see OrgSettings.redactionMrnFormats): a regex runs in
 * the shared engine and can backtrack for minutes; a script runs in an
 * interpreter with no host access, a wall-clock interrupt and a memory
 * ceiling, and any failure is a recorded no-op.
 *
 * `last_error` is the script's health line on the admin page — a failing
 * script never blocks mail (the text passes through unchanged), so without
 * this column a broken script would fail silently forever.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('email_cleaner_scripts')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('name', 'varchar(120)', (col) => col.notNull())
    .addColumn('script', 'text', (col) => col.notNull())
    .addColumn('enabled', 'boolean', (col) => col.notNull().defaultTo(true))
    .addColumn('last_error', 'text')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createIndex('idx_email_cleaner_scripts_tenant')
    .on('email_cleaner_scripts')
    .columns(['tenant_id'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('email_cleaner_scripts').execute();
}
