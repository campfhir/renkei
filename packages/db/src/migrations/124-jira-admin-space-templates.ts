import { Kysely, sql } from 'kysely';

/**
 * Jira space templates — how a Jira admin stamps out new spaces the same
 * way every time (docs/project-management-design.md, stage 1c). The plan's
 * decision: templates live in a Renkei table, not a file in a repository or
 * a Confluence page, so nothing new has to be set up to use them.
 *
 * A template is captured from a real space (`jira_admin_save_space_template`)
 * and names that space's schemes by id: work types, screens, workflows,
 * field configuration, permissions, notifications, issue security — plus
 * the space's type, default assignee and category, and the GROUPS in each
 * role. Not the people: a template describes a kind of space, and who works
 * in the next one is named when it is created. `document` holds all of it,
 * versioned in its own `version` field so its shape can grow.
 *
 * Scheme ids only mean something on the site they came from, so a template
 * belongs to one site (`cloud_id`) and is refused on any other.
 *
 * Org-wide, not per person: templates are shared among the organization's
 * Jira admins, who are the only people who make changes. `created_by` and
 * `updated_by` say who; a template is replaced whole when saved again under
 * the same name. Names are unique per site, ignoring case (`name_key`).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('jira_admin_space_templates')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('cloud_id', 'varchar(64)', (col) => col.notNull())
    .addColumn('site_url', 'varchar(255)')
    .addColumn('name', 'varchar(120)', (col) => col.notNull())
    // The name trimmed and lower-cased: the uniqueness key.
    .addColumn('name_key', 'varchar(120)', (col) => col.notNull())
    .addColumn('description', 'text')
    // The space it was captured from, for the record; the document stands alone.
    .addColumn('source_space_key', 'varchar(32)')
    .addColumn('document', 'jsonb', (col) => col.notNull())
    .addColumn('created_by', 'varchar(255)', (col) => col.notNull())
    .addColumn('updated_by', 'varchar(255)', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();

  await db.schema
    .createIndex('idx_jira_admin_space_templates_name')
    .on('jira_admin_space_templates')
    .columns(['tenant_id', 'cloud_id', 'name_key'])
    .unique()
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('jira_admin_space_templates').execute();
}
