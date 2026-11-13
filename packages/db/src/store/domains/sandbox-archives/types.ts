/**
 * Sandbox archives (migration 181): where what an evicted sandbox held
 * is kept in the blob store, one per scope, for the next sandbox the
 * scope gets. Written by the orchestrator alone.
 */
export interface SandboxArchiveRecord {
  /** The scope the archive is of. */
  routeKey: string;
  /** The sandbox it was taken from. */
  sandboxId: string;
  /** The object in the blob store. */
  blobKey: string;
  sizeBytes: number;
  createdAt: Date;
}

export interface SandboxArchiveStore {
  /** The scope's archive; null when it has none. */
  get(routeKey: string): Promise<SandboxArchiveRecord | null>;
  /**
   * Record the scope's archive, in place of any it had. Answers the one
   * it replaced (whose blob is the caller's to delete), or null.
   */
  put(archive: SandboxArchiveRecord): Promise<SandboxArchiveRecord | null>;
  /** Forget the scope's archive; answers the one that was there, or null. */
  remove(routeKey: string): Promise<SandboxArchiveRecord | null>;
  /** Archives made strictly before `before`, oldest first then by scope, at most `limit`. */
  listOlderThan(before: Date, limit: number): Promise<SandboxArchiveRecord[]>;
}
