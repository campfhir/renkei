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
}
