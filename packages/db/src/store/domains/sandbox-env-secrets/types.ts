/**
 * Workspace environment secrets (sandbox_env_secrets): a variable's name
 * and its sealed value, one per (subject, name). Sealing and opening are
 * the sandbox worker's; the store keeps the sealed text as given. Every
 * read and write names the subject, except the use stamp by row id.
 */

/** What a listing shows: the name and when — never the value. */
export interface SandboxEnvSecretRecord {
  id: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt: Date | null;
}

export interface SandboxEnvSecretStore {
  /** Set a variable: a new row (`id`), or a new sealed value and `updatedAt` for a name held. */
  upsert(secret: {
    id: string;
    subject: string;
    name: string;
    sealed: string;
    updatedAt: Date;
  }): Promise<SandboxEnvSecretRecord>;
  /** The subject's variables by name. */
  list(subject: string): Promise<SandboxEnvSecretRecord[]>;
  count(subject: string): Promise<number>;
  has(subject: string, name: string): Promise<boolean>;
  /** The sealed values by name, for the worker to open at exec time. */
  listSealed(subject: string): Promise<{ id: string; name: string; sealed: string }[]>;
  /** Note a use of these rows at `at`. */
  touchUsed(ids: string[], at: Date): Promise<void>;
  /** Delete one of the subject's variables by name; its id and name, or null. */
  delete(subject: string, name: string): Promise<{ id: string; name: string } | null>;
}
