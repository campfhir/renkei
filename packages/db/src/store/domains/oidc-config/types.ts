/**
 * The organization's identity provider configuration (oidc_config: one row
 * at most, held by a unique index on a constant). The client secret is
 * returned and stored as the ciphertext the caller sealed it to.
 */
export interface OidcConfigRecord {
  issuer: string;
  clientId: string;
  /** Ciphertext, as stored. */
  clientSecret: string;
  roleClaim: string | null;
  operatorIdpValue: string | null;
  userIdpValue: string | null;
  groupsClaim: string | null;
}

/**
 * What a save writes. `roleClaim` left undefined writes NULL on a first
 * insert and leaves the stored claim alone on a replace — the way the
 * upsert this replaced behaved.
 */
export interface OidcConfigInput {
  id: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  roleClaim?: string;
  operatorIdpValue: string | null;
  userIdpValue: string | null;
  groupsClaim: string | null;
}

export interface OidcClaimsInput {
  roleClaim: string | null;
  operatorIdpValue: string | null;
  userIdpValue: string | null;
  groupsClaim: string | null;
}

export interface OidcConfigStore {
  /** The configuration, or null before first-run setup. */
  get(): Promise<OidcConfigRecord | null>;
  /** Insert unless a configuration exists; true when this call inserted it. */
  createIfAbsent(config: OidcConfigInput): Promise<boolean>;
  /** Insert, or replace the existing configuration's fields (its id stays). */
  save(config: OidcConfigInput): Promise<void>;
  /** Replace only the claim mappings; false when there is no configuration. */
  updateClaims(claims: OidcClaimsInput): Promise<boolean>;
  /** The Renkei role an IdP role maps to, or null. */
  getRoleMapping(idpRole: string): Promise<string | null>;
  /** Map an IdP role, replacing an existing mapping of the same role. */
  setRoleMapping(mapping: { id: string; idpRole: string; renkeiRole: string }): Promise<void>;
}
