/**
 * Admin-started knowledge reindex runs (knowledge_reindex_runs): what the
 * web app asks for and reads back. The embedding worker chains the
 * batches and writes the progress; nothing here touches an embedding.
 */
export interface KnowledgeReindexRunRecord {
  id: string;
  kind: string;
  status: string;
  processed: number;
  skipped: number;
  failed: number;
  lastError: string | null;
  /** Where a resumed run picks up; null for a fresh one. */
  cursor: string | null;
  requestedBy: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface KnowledgeReindexRunStore {
  /** The newest runs, newest first (ties by id, descending), at most `limit`. */
  listRecent(limit: number): Promise<KnowledgeReindexRunRecord[]>;
  /** One run of this kind. */
  find(id: string, kind: string): Promise<KnowledgeReindexRunRecord | null>;
  /** An active (queued or running) run of this kind, oldest first; null when none. */
  findActive(kind: string): Promise<KnowledgeReindexRunRecord | null>;
  /** A new queued run. */
  create(run: { id: string; kind: string; requestedBy: string }): Promise<void>;
  /** Pause an active run of this kind; returns how many rows changed. */
  pause(id: string, kind: string): Promise<number>;
  /** Put a paused or failed run back to queued, its error and finish cleared; rows changed. */
  resume(id: string): Promise<number>;
  /** Fail a run with this error, whatever its status. */
  markFailed(id: string, error: string): Promise<void>;
}
