import type { OidcConfigInput, OidcConfigRecord } from './types';

export function oidcConfigFromRow(row: {
  issuer: string;
  client_id: string;
  client_secret: string;
  role_claim: string | null;
  operator_idp_value: string | null;
  user_idp_value: string | null;
  groups_claim: string | null;
}): OidcConfigRecord {
  return {
    issuer: row.issuer,
    clientId: row.client_id,
    clientSecret: row.client_secret,
    roleClaim: row.role_claim,
    operatorIdpValue: row.operator_idp_value,
    userIdpValue: row.user_idp_value,
    groupsClaim: row.groups_claim,
  };
}

/** The columns a save replaces on an existing row (undefined ones are left alone). */
export function oidcConfigPatch(config: OidcConfigInput) {
  return {
    issuer: config.issuer,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    role_claim: config.roleClaim,
    operator_idp_value: config.operatorIdpValue,
    user_idp_value: config.userIdpValue,
    groups_claim: config.groupsClaim,
  };
}

export function oidcConfigValues(config: OidcConfigInput) {
  return { id: config.id, ...oidcConfigPatch(config) };
}
