/** One file's answer in a bulk job: `error` null when the act went through. */
export interface ArtifactBulkResult {
  id: string;
  /** What the file was called when it was acted on, or null when it was not found. */
  filename: string | null;
  error: string | null;
}

/** A bulk act over library files, as the job and the library read it. JSON columns parsed. */
export interface ArtifactBulkJobRecord {
  id: string;
  subject: string;
  /** 'delete' | 'ocr' | 'attach'. */
  action: string;
  projectId: string | null;
  mode: string | null;
  artifactIds: string[];
  results: ArtifactBulkResult[];
  /** 'queued' | 'running' | 'done' | 'partial' | 'failed'. */
  status: string;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
  dismissedAt: Date | null;
}

export interface NewArtifactBulkJob {
  id: string;
  subject: string;
  action: string;
  projectId: string | null;
  mode: string | null;
  artifactIds: readonly string[];
}

/**
 * Bulk acts over library files (`artifact_bulk_jobs`, migration 178): the
 * row is the queue, run by apps/web/lib/chat/artifact-bulk-job.ts in the
 * web process that took the request, and by the sweep on every web process
 * when that process went away. Ids are uuids; a malformed one is refused
 * (22P02), as Postgres does, so callers check first.
 */
export interface ArtifactBulkJobStore {
  /** A new job, `queued`, nothing answered yet. */
  create(job: NewArtifactBulkJob): Promise<ArtifactBulkJobRecord>;
  /** One job by id, whoever asked for it (the job's own read), or null. */
  get(id: string): Promise<ArtifactBulkJobRecord | null>;
  /** The person's jobs not yet dismissed, newest first (ties by id, descending), at most `limit`. */
  listShown(subject: string, limit: number): Promise<ArtifactBulkJobRecord[]>;
  /** A queued job starts: `running`, touched now. False when it was not queued (another took it). */
  startQueued(id: string): Promise<boolean>;
  /**
   * Take over a `running` job untouched for longer than `staleMs` (its process went away): touched
   * now, so of two sweeps exactly one wins. False otherwise.
   */
  reclaimStale(id: string, staleMs: number): Promise<boolean>;
  /**
   * The answers so far, which is also the job's heartbeat: written, and touched now, only while it
   * is `running`. False otherwise.
   */
  recordResults(id: string, results: readonly ArtifactBulkResult[]): Promise<boolean>;
  /**
   * The job ends in `status`, finished now, `lastError` written when given; `dismiss` also dismisses
   * it now. Only a queued or running job; false otherwise.
   */
  finish(
    id: string,
    outcome: { status: string; lastError?: string; dismiss: boolean }
  ): Promise<boolean>;
  /** The person closes a finished job of theirs: dismissed now. False when it is not theirs, not
   *  finished, or already dismissed. */
  dismiss(id: string, subject: string): Promise<boolean>;
  /** What the sweep should look at: queued, or running untouched for longer than `staleMs`; least
   *  recently touched first (ties by id), at most `limit`. */
  listRunnable(
    staleMs: number,
    limit: number
  ): Promise<{ id: string; status: 'queued' | 'running' }[]>;
}
