import { Kysely, sql } from 'kysely';

/**
 * The identity spine: who an OIDC subject is across the platform.
 *
 * Every credential Renkei mints is bound to a subject, but the gates verify
 * access by what providers understand — an email. Until now the mapping
 * lived nowhere: the id_token's claims were read for roles at sign-in and
 * discarded. This table keeps them, upserted on every sign-in so a changed
 * email heals on the next session.
 *
 * The mapping is recorded identity, not authorization — the gates still
 * verify live with the provider; this only tells them who to ask about.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('identities')
    .addColumn('tenant_id', 'uuid', (col) => col.notNull().references('tenants.id'))
    .addColumn('subject', 'varchar(255)', (col) => col.notNull())
    .addColumn('email', 'varchar(320)', (col) => col.notNull())
    .addColumn('display_name', 'varchar(255)')
    .addColumn('created_at', 'timestamp', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamp', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addPrimaryKeyConstraint('identities_pk', ['tenant_id', 'subject'])
    .execute();

  // Reverse lookup (email → subjects) for future per-viewer verification
  // at display surfaces.
  await db.schema
    .createIndex('identities_tenant_email_idx')
    .on('identities')
    .columns(['tenant_id', 'email'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('identities').execute();
}
