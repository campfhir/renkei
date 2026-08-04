import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // Create table for mapping IDP roles to renkei roles
  // Supports many-to-many: multiple IDP roles can map to the same renkei role
  await db.schema
    .createTable('oidc_role_mappings')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('tenant_id', 'uuid', (col) => col.notNull().references('tenants.id'))
    .addColumn('idp_role', 'varchar(255)', (col) => col.notNull())
    .addColumn('renkei_role', 'varchar(255)', (col) => col.notNull())
    .addColumn('created_at', 'timestamp', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addUniqueConstraint('oidc_role_mappings_tenant_idp_unique', ['tenant_id', 'idp_role'])
    .execute();

  await db.schema
    .createIndex('idx_oidc_role_mappings_tenant')
    .on('oidc_role_mappings')
    .column('tenant_id')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('oidc_role_mappings').execute();
}
