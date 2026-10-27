/** A registered MCP OAuth client, as the authorize step checks it. */
export interface OAuthClientRecord {
  clientId: string;
  clientName: string | null;
  redirectUris: string[];
  createdAt: Date;
}

/** A recorded "may this client act as you?" question, waiting for its answer. */
export interface ConsentRequestRecord {
  id: string;
  clientId: string;
  sessionId: string;
  subject: string;
  redirectUri: string;
  state: string;
  scope: string | null;
  codeChallenge: string;
  codeChallengeMethod: string;
  expiresAt: Date;
}

/** The consent request with what the consent page says about its client. */
export interface ConsentRequestView extends ConsentRequestRecord {
  clientName: string | null;
  clientCreatedAt: Date;
}

/** A dynamically registered client (RFC 7591): only the secret's digest is kept. */
export interface NewOAuthClient {
  clientId: string;
  clientSecretHash: string;
  clientName: string | null;
  redirectUris: string[];
  responseTypes: string[];
  grantTypes: string[];
}

export interface NewAuthorizationCode {
  code: string;
  clientId: string;
  subject: string;
  scope: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  roles: string[];
  expiresAt: Date;
}

/**
 * The MCP OAuth authorize/consent round trip: the client lookup, the
 * pending request the consent page renders, its one-time answer and the
 * code an "allow" mints. Request ids arrive from forms and URLs; a
 * malformed one is refused (22P02), as Postgres does.
 */
export interface OAuthConsentStore {
  getClient(clientId: string): Promise<OAuthClientRecord | null>;
  /** Drop requests that expired before `now`; returns how many went. */
  sweepExpired(now: Date): Promise<number>;
  /** Record a request (its client and session must exist: 23503 otherwise). */
  createRequest(request: ConsentRequestRecord): Promise<void>;
  /** A pending request with its client's name and registration time, expired or not. */
  getRequest(id: string): Promise<ConsentRequestView | null>;
  /** Remove and return a request — spent on the first answer, whatever it is. */
  takeRequest(id: string): Promise<ConsentRequestRecord | null>;
  insertAuthorizationCode(code: NewAuthorizationCode): Promise<void>;
  /** Register a client; a client id already taken is refused (23505). */
  registerClient(client: NewOAuthClient): Promise<void>;
}
