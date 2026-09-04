import { Kysely, sql } from 'kysely';

/**
 * Prompt libraries: named collections of reusable prompts a person
 * writes once and inserts into the chat composer, shareable with named
 * colleagues (resource_access_grants, 092) or published to the whole
 * organization.
 *
 * Prompt bodies are stored in plaintext, unlike chat content: they are
 * templates meant to be read by other people, and the picker filters on
 * their text. A library whose prompts must stay private is simply not
 * shared. `position` is the author's ordering; the picker shows it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('prompt_libraries')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('owner_subject', 'varchar(255)', (col) => col.notNull())
    .addColumn('name', 'varchar(200)', (col) => col.notNull())
    .addColumn('description', 'text')
    .addColumn('published_to_org', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();
  await db.schema
    .createIndex('idx_prompt_libraries_owner')
    .on('prompt_libraries')
    .columns(['tenant_id', 'owner_subject', 'updated_at desc'])
    .execute();
  await sql`
    CREATE INDEX idx_prompt_libraries_published
      ON prompt_libraries (tenant_id) WHERE published_to_org
  `.execute(db);

  await db.schema
    .createTable('prompts')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('library_id', 'uuid', (col) =>
      col.notNull().references('prompt_libraries.id').onDelete('cascade')
    )
    .addColumn('title', 'varchar(200)', (col) => col.notNull())
    .addColumn('body', 'text', (col) => col.notNull())
    .addColumn('position', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('created_by_subject', 'varchar(255)', (col) => col.notNull())
    .addColumn('updated_by_subject', 'varchar(255)', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();
  await db.schema
    .createIndex('idx_prompts_library')
    .on('prompts')
    .columns(['library_id', 'position'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('prompts').execute();
  await db.schema.dropTable('prompt_libraries').execute();
}
