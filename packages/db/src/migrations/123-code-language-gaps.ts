import { Kysely, sql } from 'kysely';

/**
 * Which files the code pane opens without a language server behind them.
 *
 * The pane gives a file a language server by its extension (the
 * registry in packages/connector-sandbox/src/lsp.ts; the servers the
 * sandbox image carries). A file whose language has no server in the
 * registry, or whose server this deployment's worker does not have, gets
 * syntax colouring alone — and nobody hears of it. This table is the
 * record: one row per (tenant, extension, language, reason), with how
 * many times such a file was opened and when, so the next language to
 * add is a query away rather than a guess. No UI reads it.
 *
 * `extension` is the file's extension, lower-cased, or its whole name
 * when it has none (`Makefile`) or is all extension (`.bashrc`);
 * `language` is the Monaco language the pane chose for it (`plaintext`
 * for one it does not know). `reason`: `no_server`, the registry names
 * no server for the language; `not_installed`, it names one the worker
 * lacks. `sample_path` is the last such path opened, for a look.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('code_language_gaps')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('extension', 'varchar(64)', (col) => col.notNull())
    .addColumn('language', 'varchar(64)', (col) => col.notNull())
    .addColumn('reason', 'varchar(16)', (col) =>
      col.notNull().check(sql`reason IN ('no_server', 'not_installed')`)
    )
    .addColumn('open_count', 'integer', (col) => col.notNull().defaultTo(1))
    .addColumn('sample_path', 'text')
    .addColumn('first_seen_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('last_seen_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('code_language_gaps_key', ['tenant_id', 'extension', 'language', 'reason'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('code_language_gaps').execute();
}
