/**
 * Run tokens (@renkei/mcp-client): the access tokens a server-side process
 * mints to act as a person at the MCP endpoint, and the one synthetic
 * OAuth client they hang off (oauth_access_tokens.client_id is a foreign
 * key). Only a token's SHA-256 digest is ever stored.
 */

export interface RunTokenRecord {
  tokenHash: string;
  clientId: string;
  subject: string;
  application: string;
  agentId: string | null;
  scope: string | null;
  roles: string[];
  toolNames: string[] | null;
  /** The sandbox scratch space a chat turn's token stages in (migration 169); null otherwise. */
  sandboxScope: string | null;
  expiresAt: Date;
}

export type NewRunToken = Omit<RunTokenRecord, 'roles' | 'sandboxScope'> & {
  roles?: string[];
  sandboxScope?: string | null;
};

export interface RunTokenStore {
  /** Create the synthetic client unless it exists (an existing one is left as it is). */
  ensureClient(client: { clientId: string; clientName: string; secretHash: string }): Promise<void>;
  /**
   * Store one token's digest; `roles` omitted stores the column default
   * (none), `sandboxScope` omitted stores null.
   */
  insert(token: NewRunToken): Promise<void>;
  /** Drop a token by its digest; returns how many went. */
  delete(tokenHash: string): Promise<number>;
  /** One token by its digest. */
  find(tokenHash: string): Promise<RunTokenRecord | null>;
}
