/** A browser session row: an opaque id naming a subject and its roles. */
export interface SessionRecord {
  id: string;
  subject: string;
  roles: string[];
  expiresAt: Date;
  lastUsedAt: Date;
}

export interface SessionStore {
  create(session: { id: string; subject: string; roles: string[]; expiresAt: Date }): Promise<void>;
  /** Null when no such session exists — expiry is the caller's rule, not the store's. */
  find(id: string): Promise<SessionRecord | null>;
  /** Move `lastUsedAt` forward; unknown ids are ignored. */
  touch(id: string, at: Date): Promise<void>;
  delete(id: string): Promise<void>;
  /** Each subject's newest session use, by subject. Subjects with no session are absent. */
  lastUsedBySubject(): Promise<{ subject: string; lastUsedAt: Date }[]>;
  /** One subject's newest session use, or null when they hold none. */
  lastUsedOf(subject: string): Promise<Date | null>;
  /** The roles of a subject's most recently used session (ties by id), or null when they hold none. */
  latestRolesOf(subject: string): Promise<string[] | null>;
  /** End every browser session of a subject; returns how many went. */
  deleteForSubject(subject: string): Promise<number>;
  /**
   * End everything a subject is signed in with — browser sessions and MCP
   * access and refresh tokens — in one step; returns how many of each went.
   */
  revokeAll(
    subject: string
  ): Promise<{ sessions: number; accessTokens: number; refreshTokens: number }>;
}
