/** What first-run setup asks of the store: whether there is anything left to set up. */
export interface FirstRunStore {
  /** Whether an identity provider (an `oidc_config` row) exists yet. */
  identityProviderConfigured(): Promise<boolean>;
}
