import { Kysely, sql } from 'kysely';

/**
 * Web crawls run by the sandbox worker (sandbox_browser_crawl): one staged
 * call starts a crawl of many pages, the worker visits them in the
 * background, and the sandbox_crawl_* read tools hand the pages back.
 *
 *  - `sandbox_crawls`: one crawl — its recipe (the approved scope: origin,
 *    pattern, the pages it names), its status, and the queue of pages
 *    still to visit, so a crawl the worker was stopped in the middle of
 *    resumes where it was.
 *  - `sandbox_crawl_pages`: what each visited page held. `content` is the
 *    page's text and tables as rows, sealed by the worker under a key
 *    derived per subject (the browser-state discipline) — never stored in
 *    the clear. The rest of the row is what a listing shows without
 *    opening anything.
 *  - `sandbox_crawl_recipes`: a crawl saved by name, so a later run (or a
 *    later chat) re-crawls or resumes it without working the scope out
 *    again.
 *
 * Crawls and their pages expire (`expires_at`, the worker's sweep);
 * recipes are kept until deleted.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('sandbox_crawls')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('subject', 'varchar(255)', (col) => col.notNull())
    .addColumn('recipe_name', 'varchar(200)')
    .addColumn('recipe', 'jsonb', (col) => col.notNull())
    // queued | running | completed | stopped | failed
    .addColumn('status', 'varchar(20)', (col) => col.notNull())
    // Pages still to visit, in order: [{url, depth}].
    .addColumn('queue', 'jsonb', (col) => col.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn('pages_done', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('pages_failed', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('error', 'text')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('finished_at', 'timestamptz')
    .addColumn('expires_at', 'timestamptz', (col) => col.notNull())
    .execute();
  await db.schema
    .createIndex('idx_sandbox_crawls_owner_time')
    .on('sandbox_crawls')
    .columns(['subject', 'created_at'])
    .execute();
  await db.schema
    .createIndex('idx_sandbox_crawls_expiry')
    .on('sandbox_crawls')
    .column('expires_at')
    .execute();

  await db.schema
    .createTable('sandbox_crawl_pages')
    .addColumn('crawl_id', 'uuid', (col) =>
      col.notNull().references('sandbox_crawls.id').onDelete('cascade')
    )
    .addColumn('url', 'text', (col) => col.notNull())
    // Visit order within the crawl, 1-based.
    .addColumn('seq', 'integer', (col) => col.notNull())
    .addColumn('depth', 'integer', (col) => col.notNull().defaultTo(0))
    // ok | failed
    .addColumn('status', 'varchar(20)', (col) => col.notNull())
    .addColumn('title', 'text')
    .addColumn('content', 'text')
    .addColumn('text_chars', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('table_count', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('error', 'text')
    .addColumn('fetched_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addPrimaryKeyConstraint('sandbox_crawl_pages_pkey', ['crawl_id', 'url'])
    .execute();
  await db.schema
    .createIndex('idx_sandbox_crawl_pages_order')
    .on('sandbox_crawl_pages')
    .columns(['crawl_id', 'seq'])
    .execute();

  await db.schema
    .createTable('sandbox_crawl_recipes')
    .addColumn('subject', 'varchar(255)', (col) => col.notNull())
    .addColumn('name', 'varchar(200)', (col) => col.notNull())
    .addColumn('recipe', 'jsonb', (col) => col.notNull())
    .addColumn('last_crawl_id', 'uuid', (col) =>
      col.references('sandbox_crawls.id').onDelete('set null')
    )
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addPrimaryKeyConstraint('sandbox_crawl_recipes_pkey', ['subject', 'name'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('sandbox_crawl_recipes').execute();
  await db.schema.dropTable('sandbox_crawl_pages').execute();
  await db.schema.dropTable('sandbox_crawls').execute();
}
