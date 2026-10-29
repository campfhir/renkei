/**
 * Sandbox browser secrets (sandbox_secrets): the sealed blob and its
 * non-secret description. The store keeps the blob as sealed text; only
 * the worker's in-memory vault can open it. Every per-caller read and
 * write names the subject; the sweep's expiry walk is the read across
 * callers.
 */

export interface SandboxSecretRecord {
  id: string;
  subject: string;
  name: string;
  fields: string[];
  hosts: string[];
  sealed: string;
  createdAt: Date;
  expiresAt: Date;
  lastUsedAt: Date | null;
}

export interface SandboxSecretStore {
  insert(
    secret: Omit<SandboxSecretRecord, 'createdAt' | 'lastUsedAt'>
  ): Promise<SandboxSecretRecord>;
  /** The subject's secrets by name. */
  list(subject: string): Promise<SandboxSecretRecord[]>;
  count(subject: string): Promise<number>;
  get(subject: string, id: string): Promise<SandboxSecretRecord | null>;
  getByName(subject: string, name: string): Promise<SandboxSecretRecord | null>;
  /** Note a use at `at`. */
  touchUsed(id: string, at: Date): Promise<void>;
  /** Delete one of the subject's secrets; its id and name, or null. */
  delete(subject: string, id: string): Promise<{ id: string; name: string } | null>;
  /** Ids of secrets expiring before `before`, soonest first (ties by id), at most `limit`. */
  listExpiredIds(before: Date, limit: number): Promise<string[]>;
  deleteById(id: string): Promise<void>;
}
