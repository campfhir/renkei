/**
 * The sandbox worker's staged-file metadata (sandbox_files). Bytes live on
 * the worker's disk; this is only the row. Every per-caller read names the
 * subject and the scope it was staged from (migration 169: `chat:<id>`,
 * `project:<id>`, or '' for the person's own scratch space); a batch's
 * quota pool (`batchId`) is the one aggregate keyed otherwise, and the
 * sweep's expiry walk the one read across callers.
 */

export interface SandboxFileRecord {
  id: string;
  subject: string;
  scope: string;
  filename: string;
  contentType: string | null;
  sizeBytes: number;
  storageKey: string;
  source: string;
  batchId: string | null;
  createdAt: Date;
  expiresAt: Date;
}

export interface SandboxFileStore {
  /** Record a staged file. */
  insert(file: Omit<SandboxFileRecord, 'createdAt'>): Promise<SandboxFileRecord>;
  /**
   * The subject's files staged in `scope`, newest first, ties by id; with
   * `batchId`, that batch's files instead, from whichever scope started it.
   */
  list(subject: string, scope: string, batchId?: string): Promise<SandboxFileRecord[]>;
  /** How many files the subject holds. */
  countForSubject(subject: string): Promise<number>;
  /** The subject's staged bytes in total (0 with none). */
  totalBytesForSubject(subject: string): Promise<number>;
  /** How many files one batch holds, whoever staged them. */
  countForBatch(batchId: string): Promise<number>;
  /** One batch's staged bytes in total (0 with none). */
  totalBytesForBatch(batchId: string): Promise<number>;
  /**
   * One of the subject's files staged in `scope` — or in any batch of
   * theirs, which the batch's id already names — or null.
   */
  get(subject: string, scope: string, id: string): Promise<SandboxFileRecord | null>;
  /** Delete one of the files `get` would return; the row it was, or null. */
  delete(subject: string, scope: string, id: string): Promise<SandboxFileRecord | null>;
  /** Files whose expiry is before `before`, soonest expiring first (ties by id), at most `limit`. */
  listExpired(before: Date, limit: number): Promise<SandboxFileRecord[]>;
  /** Delete a file's row by id alone (the sweep). */
  deleteById(id: string): Promise<void>;
}
