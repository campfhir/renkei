/** A bulk mail job as its status tool reads it. JSON columns are parsed, unread. */
export interface MailBulkJobRecord {
  id: string;
  subject: string;
  accountId: string;
  action: string;
  params: unknown;
  selection: unknown;
  status: string;
  total: number | null;
  succeeded: number;
  failed: number;
  failures: unknown;
  lastError: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface NewMailBulkJob {
  id: string;
  subject: string;
  accountId: string;
  action: string;
  params: Record<string, unknown>;
  selection: Record<string, unknown>;
}

/**
 * Bulk Outlook jobs (`mail_bulk_jobs`): queued by the MCP tool, run by the
 * mailjobs worker. Job ids arrive from tool arguments; a malformed one is
 * refused (22P02), as Postgres does.
 */
export interface MailBulkJobStore {
  /** A new job, `queued`. */
  create(job: NewMailBulkJob): Promise<void>;
  /** Mark a job failed with `error` (it could not be enqueued). */
  markFailed(id: string, error: string): Promise<void>;
  /** The subject's own job, or null — someone else's id reads as missing. */
  getOwned(id: string, subject: string): Promise<MailBulkJobRecord | null>;
  /** One job by id, whoever owns it (the runner's read), or null. */
  get(id: string): Promise<MailBulkJobRecord | null>;
  /** The job starts: `running`, started now. */
  markRunning(id: string): Promise<void>;
  /** How many messages the selection expanded to. */
  setTotal(id: string, total: number): Promise<void>;
  /** The running counts and the kept per-message failures, as chunks settle. */
  recordProgress(
    id: string,
    progress: { succeeded: number; failed: number; failures: unknown[] }
  ): Promise<void>;
  /** The job ends in `status`, finished now; `lastError` is written when given. */
  finish(id: string, outcome: { status: string; lastError?: string }): Promise<void>;
}
