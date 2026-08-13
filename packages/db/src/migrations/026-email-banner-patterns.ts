import { Kysely, sql } from 'kysely';

/**
 * A tenant-editable library of literal "external sender" warning-banner
 * phrases mail gateways/transport rules prepend to messages (e.g. "CAUTION:
 * This Email is from an EXTERNAL source..."). Content-free the same way
 * `email_classifier_rules` is: a phrase is boilerplate the org's own mail
 * infrastructure injects, never the sender's own words, so an org-admin
 * route may read and write it directly. This is what makes a new gateway
 * wording a data change here rather than a code deploy — see
 * packages/email-sanitizer's clean/generic.ts (`stripExternalSenderBanner`),
 * which strips any enabled phrase from a message before it's embedded,
 * without truncating the real content that follows it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('email_banner_patterns')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('tenant_id', 'uuid', (col) => col.notNull().references('tenants.id'))
    .addColumn('phrase', 'text', (col) => col.notNull())
    .addColumn('enabled', 'boolean', (col) => col.notNull().defaultTo(true))
    .addColumn('created_at', 'timestamp', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamp', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();

  await db.schema
    .createIndex('idx_email_banner_patterns_tenant')
    .on('email_banner_patterns')
    .columns(['tenant_id'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('email_banner_patterns').execute();
}
