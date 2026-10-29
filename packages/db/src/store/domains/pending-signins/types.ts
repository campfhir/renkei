/**
 * One in-flight redirect round trip (pending_oidc_signin): an OIDC sign-in
 * or a connector's OAuth connect, keyed by the single-use `state` it sent
 * the browser off with. Expiry is the caller's rule; the store keeps and
 * returns the row as written.
 */
export interface PendingSigninRecord {
  state: string;
  nonce: string;
  /** Who started a connect; null for a sign-in, where nobody is signed in yet. */
  subject: string | null;
  /** The connector the callback dispatches on; null for a sign-in (and pre-column Jira rows). */
  provider: string | null;
  scopes: string | null;
  /** The PKCE verifier the callback presents at the token endpoint, when the flow uses one. */
  codeVerifier: string | null;
  /** Which of a provider's connectors (a Salesforce org) the flow is for, when it has several. */
  connectorKey: string | null;
  expiresAt: Date;
}

/** What a new round trip records; the optional fields default to null, `createdAt` to now. */
export interface PendingSigninInput {
  id: string;
  state: string;
  nonce: string;
  subject?: string | null;
  provider?: string | null;
  scopes?: string | null;
  codeVerifier?: string | null;
  connectorKey?: string | null;
  expiresAt: Date;
  createdAt?: Date;
}

export interface PendingSigninStore {
  /** Record a round trip. A second row with the same id or state is refused (23505). */
  create(pending: PendingSigninInput): Promise<void>;
  /** The round trip this state names, expired or not; null when there is none. */
  findByState(state: string): Promise<PendingSigninRecord | null>;
  /** Spend a state (single use); returns how many rows went. */
  deleteByState(state: string): Promise<number>;
}
