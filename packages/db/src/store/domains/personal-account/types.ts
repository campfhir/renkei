/** A connected grant's scopes, read from the plaintext column — never its tokens. */
export interface GrantScopesRecord {
  provider: string;
  providerAccountId: string;
  /** Null when the provider never reported what it granted. */
  grantedScopes: string[] | null;
}

/** An agent a person owns, by name only. */
export interface OwnedAgentName {
  id: string;
  name: string;
}

/**
 * Small reads about one person's own account that the preferences and
 * activity pages need: what their grants carry, and what agents they own.
 */
export interface PersonalAccountStore {
  /** This person's grants for these providers, by provider then account id. */
  grantScopes(subject: string, providers: string[]): Promise<GrantScopesRecord[]>;
  /** The account id of this person's grant for `provider` (the lowest, if several), or null. */
  providerAccountId(subject: string, provider: string): Promise<string | null>;
  /** The agents this person owns, by name (ties by id). */
  ownedAgentNames(subject: string): Promise<OwnedAgentName[]>;
}
