import { sql, type Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import { oidcConfigFromRow, oidcConfigPatch, oidcConfigValues } from './record';
import type { OidcConfigStore } from './types';

export function postgresOidcConfig(db: () => Kysely<DB>): OidcConfigStore {
  return {
    async get() {
      const row = await db()
        .selectFrom('oidc_config')
        .select([
          'issuer',
          'client_id',
          'client_secret',
          'role_claim',
          'operator_idp_value',
          'user_idp_value',
          'groups_claim',
        ])
        .executeTakeFirst();
      return row ? oidcConfigFromRow(row) : null;
    },
    async createIfAbsent(config) {
      const result = await db()
        .insertInto('oidc_config')
        .values(oidcConfigValues(config))
        .onConflict((oc) => oc.expression(sql`(true)`).doNothing())
        .executeTakeFirst();
      return Number(result?.numInsertedOrUpdatedRows ?? 0) > 0;
    },
    async save(config) {
      await db()
        .insertInto('oidc_config')
        .values(oidcConfigValues(config))
        .onConflict((oc) => oc.expression(sql`(true)`).doUpdateSet(oidcConfigPatch(config)))
        .execute();
    },
    async updateClaims(claims) {
      const result = await db()
        .updateTable('oidc_config')
        .set({
          role_claim: claims.roleClaim,
          operator_idp_value: claims.operatorIdpValue,
          user_idp_value: claims.userIdpValue,
          groups_claim: claims.groupsClaim,
        })
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    },
    async getRoleMapping(idpRole) {
      const row = await db()
        .selectFrom('oidc_role_mappings')
        .select('renkei_role')
        .where('idp_role', '=', idpRole)
        .executeTakeFirst();
      return row?.renkei_role ?? null;
    },
    async setRoleMapping({ id, idpRole, renkeiRole }) {
      await db()
        .insertInto('oidc_role_mappings')
        .values({ id, idp_role: idpRole, renkei_role: renkeiRole })
        .onConflict((oc) => oc.columns(['idp_role']).doUpdateSet({ renkei_role: renkeiRole }))
        .execute();
    },
  };
}
