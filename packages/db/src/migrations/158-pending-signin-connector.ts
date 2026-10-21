import { Kysely } from 'kysely';

/**
 * Which connector of a type a connect flow is for, when a type has more
 * than one: an organization adds one Salesforce connector per Salesforce
 * org (production, each sandbox), and the shared OAuth callback must know
 * which org's token endpoint and app the returning code belongs to. Null
 * for every connector that is one of a kind.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('pending_oidc_signin')
    .addColumn('connector_key', 'varchar(64)')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('pending_oidc_signin').dropColumn('connector_key').execute();
}
