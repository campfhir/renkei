/**
 * An access token as the transport resolves it. Only the digest is ever
 * stored (`tokenHash`), never the token.
 */
export interface OAuthAccessTokenRecord {
  tokenHash: string;
  subject: string;
  clientId: string;
  scope: string | null;
  application: string;
  agentId: string | null;
  roles: string[];
  toolNames: string[] | null;
  expiresAt: Date;
}

export interface NewOAuthAccessToken {
  tokenHash: string;
  clientId: string;
  subject: string;
  /** 'jira' (an MCP client), 'agent' or 'widget'. */
  application: string;
  scope: string | null;
  roles: string[];
  expiresAt: Date;
}

export interface NewOAuthRefreshToken {
  tokenId: string;
  clientId: string;
  subject: string;
  scope: string | null;
  roles: string[];
  tokenHash: string;
  expiresAt: Date;
}

/** What presenting a refresh token came to (see `rotateRefreshToken`). */
export type OAuthRefreshRotation =
  | { outcome: 'not_found' }
  | { outcome: 'client_mismatch' }
  | { outcome: 'expired'; familyId: string }
  | { outcome: 'reused'; subject: string; familyId: string }
  | { outcome: 'rotated'; subject: string; scope: string | null; roles: string[] };

/**
 * The MCP OAuth server's bearer credentials: access tokens (`oauth_access_tokens`)
 * and the refresh-token families (`oauth_refresh_tokens`, migration 147).
 */
export interface OAuthTokenStore {
  insertAccessToken(token: NewOAuthAccessToken): Promise<void>;
  /** The token with this digest issued for `application`, expired or not. */
  findAccessToken(tokenHash: string, application: string): Promise<OAuthAccessTokenRecord | null>;
  /** Returns how many rows went (0 or 1). */
  deleteAccessToken(tokenHash: string): Promise<number>;
  /** A family's first refresh token (its family id is fresh). */
  insertRefreshToken(token: NewOAuthRefreshToken): Promise<void>;
  /**
   * Exchange a presented refresh token, in one transaction with the
   * presented row locked (FOR UPDATE), so two concurrent refreshes with
   * one token serialize:
   *
   *   - no token with this digest: `not_found`;
   *   - issued to another client: `client_mismatch`;
   *   - past its family's expiry at `now`: the family is deleted, `expired`;
   *   - already rotated (REUSE): the family is deleted along with the
   *     subject's 'jira' access tokens for this client, `reused`;
   *   - otherwise the token is marked rotated at `now`, its successor
   *     (`next`) joins the family with the family's expiry, an access
   *     token (`access`, application 'jira') is stored, and `rotated`.
   *
   * The roles carried forward are those of the subject's newest browser
   * session live at `now`, else the presented token's own.
   */
  rotateRefreshToken(request: {
    presentedHash: string;
    clientId: string;
    now: Date;
    next: { tokenId: string; tokenHash: string };
    access: { tokenHash: string; expiresAt: Date };
  }): Promise<OAuthRefreshRotation>;
}
