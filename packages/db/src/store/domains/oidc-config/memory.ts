import type { MemoryTables } from '../../memory/tables';
import { oidcConfigFromRow, oidcConfigPatch, oidcConfigValues } from './record';
import type { OidcConfigStore } from './types';

/** oidc_config holds one row at most: "a row exists" is the conflict. */
export function memoryOidcConfig(tables: MemoryTables): OidcConfigStore {
  const existing = () => tables.select('oidc_config')[0];
  const newRow = (config: Parameters<OidcConfigStore['save']>[0]) => {
    const values = oidcConfigValues(config);
    return { ...values, role_claim: values.role_claim ?? null, created_at: new Date() };
  };
  return {
    async get() {
      const row = existing();
      return row ? oidcConfigFromRow(row) : null;
    },
    async createIfAbsent(config) {
      if (existing()) return false;
      tables.insert('oidc_config', newRow(config));
      return true;
    },
    async save(config) {
      const row = existing();
      if (!row) {
        tables.insert('oidc_config', newRow(config));
        return;
      }
      tables.update('oidc_config', (r) => r.id === row.id, oidcConfigPatch(config));
    },
    async updateClaims(claims) {
      return (
        tables.update('oidc_config', () => true, {
          role_claim: claims.roleClaim,
          operator_idp_value: claims.operatorIdpValue,
          user_idp_value: claims.userIdpValue,
          groups_claim: claims.groupsClaim,
        }).length > 0
      );
    },
    async getRoleMapping(idpRole) {
      return tables.first('oidc_role_mappings', (r) => r.idp_role === idpRole)?.renkei_role ?? null;
    },
    async setRoleMapping({ id, idpRole, renkeiRole }) {
      tables.upsert(
        'oidc_role_mappings',
        { id, idp_role: idpRole, renkei_role: renkeiRole, created_at: new Date() },
        ['idp_role'],
        { renkei_role: renkeiRole }
      );
    },
  };
}
