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
}
