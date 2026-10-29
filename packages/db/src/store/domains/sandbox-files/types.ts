/**
 * The sandbox worker's staged-file metadata (sandbox_files). Bytes live on
 * the worker's disk; this is only the row. Every per-caller read names the
 * subject; a batch's quota pool (`batchId`) is the one aggregate keyed
 * otherwise, and the sweep's expiry walk the one read across callers.
 */

export interface SandboxFileRecord {
  id: string;
  subject: string;
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
  /** The subject's files (optionally one batch's), newest first, ties by id. */
  list(subject: string, batchId?: string): Promise<SandboxFileRecord[]>;
  /** How many files the subject holds. */
  countForSubject(subject: string): Promise<number>;
  /** The subject's staged bytes in total (0 with none). */
  totalBytesForSubject(subject: string): Promise<number>;
  /** How many files one batch holds, whoever staged them. */
  countForBatch(batchId: string): Promise<number>;
  /** One batch's staged bytes in total (0 with none). */
  totalBytesForBatch(batchId: string): Promise<number>;
  /** One of the subject's files, or null. */
  get(subject: string, id: string): Promise<SandboxFileRecord | null>;
  /** Delete one of the subject's files; the row it was, or null. */
  delete(subject: string, id: string): Promise<SandboxFileRecord | null>;
  /** Files whose expiry is before `before`, soonest expiring first (ties by id), at most `limit`. */
  listExpired(before: Date, limit: number): Promise<SandboxFileRecord[]>;
  /** Delete a file's row by id alone (the sweep). */
  deleteById(id: string): Promise<void>;
}
