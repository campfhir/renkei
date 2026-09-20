import { Kysely, sql } from 'kysely';

/**
 * Code project templates: an org's own catalog of starting instructions
 * for the new-code-project form, alongside the built-in ones shipped in
 * code (apps/web/lib/code/project-templates.ts). Picking one only fills
 * the instructions textarea — it stays fully editable afterward, so a
 * template is a starting point to re-author, not a locked-in choice.
 *
 * Bodies are stored in plaintext, like prompt_libraries' prompts: they
 * are meant to be read (and copied, and edited) by whoever is creating a
 * project, not private user content.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('code_project_templates')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('name', 'varchar(200)', (col) => col.notNull())
    .addColumn('description', 'text')
    .addColumn('instructions', 'text', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();

  // Names are how the new-project picker and the admin catalog both refer
  // to a template; two "Microservice" entries in one org is confusing.
  await db.schema
    .createIndex('idx_code_project_templates_tenant_name')
    .unique()
    .on('code_project_templates')
    .columns(['tenant_id', 'name'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('code_project_templates').execute();
}
