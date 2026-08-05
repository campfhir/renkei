import { Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // Replace comma-separated required_role with separate operator and user IDP value fields
  await db.schema
    .alterTable('tenant_oidc')
    .dropColumn('required_role')
    .addColumn('operator_idp_value', 'varchar(255)')
    .addColumn('user_idp_value', 'varchar(255)')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('tenant_oidc')
    .dropColumn('operator_idp_value')
    .dropColumn('user_idp_value')
    .addColumn('required_role', 'varchar(255)')
    .execute();
}
