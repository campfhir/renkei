/** One provider grant's plain columns — never its tokens. */
export interface GrantSummary {
  providerAccountId: string;
  displayName: string;
  /** Parsed JSON, unread. */
  metadata: unknown;
  requestedScopes: string[];
}

/** A person's Salesforce connections, read from provider_grants without opening a token. */
export interface SalesforceGrantStore {
  /** This person's grants for `provider`, by account id. */
  listConnections(subject: string, provider: string): Promise<GrantSummary[]>;
}
