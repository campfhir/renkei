/**
 * One batch job: long-running work over many items (today, a fileshare
 * folder through OCR). `config`, an item's `payload` and `result` come
 * back as stored — the callers (packages/batch-jobs-store) read their
 * shape.
 */
export interface BatchJobRecord {
  id: string;
  subject: string;
  name: string;
  kind: string;
  config: unknown;
  status: string;
  total: number | null;
  succeeded: number;
  failed: number;
  skipped: number;
  lastError: string | null;
  scheduleId: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
}

export interface BatchJobItemRecord {
  id: string;
  batchId: string;
  status: string;
  payload: unknown;
  result: unknown;
  error: string | null;
}

export interface NewBatchJob {
  /** Generated when left out. */
  id?: string;
  subject: string;
  name: string;
  kind: string;
  config: unknown;
  scheduleId?: string | null;
}

export interface NewBatchJobItem {
  /** Generated when left out. */
  id?: string;
  /** Defaults to 'pending'. */
  status?: string;
  payload: unknown;
  result?: unknown;
}

/**
 * batch_jobs and batch_job_items. The status machine's rules (which
 * counters make a batch complete, and with which outcome) stay with the
 * caller; every transition here is a single guarded UPDATE that resolves
 * to the changed row, or undefined when its guard matched nothing — so
 * only the caller that actually made a transition sees a row.
 */
export interface BatchJobStore {
  create(batch: NewBatchJob): Promise<BatchJobRecord>;
  get(batchId: string): Promise<BatchJobRecord | undefined>;
  /**
   * One person's batches, newest first (ties by id). `limit` 0 or left out
   * is no limit; `status` and `scheduleId` narrow it.
   */
  list(
    subject: string,
    options?: { limit?: number; status?: string; scheduleId?: string }
  ): Promise<BatchJobRecord[]>;
  /** 'queued' → 'discovering', stamping `startedAt`. */
  beginDiscovery(batchId: string): Promise<BatchJobRecord | undefined>;
  /** Any non-terminal status → 'failed' with `message`. */
  fail(batchId: string, message: string): Promise<BatchJobRecord | undefined>;
  /**
   * Any non-terminal status → 'succeeded' with nothing to run: `total`
   * becomes `skipped`, which is also added to the skipped counter.
   */
  completeEmpty(batchId: string, skipped: number): Promise<BatchJobRecord | undefined>;
  /** → 'running' with `total` set and `skipped` added to the counter (unguarded). */
  activate(batchId: string, total: number, skipped: number): Promise<BatchJobRecord | undefined>;
  /** Add to the counters in one atomic UPDATE; the row as it now stands. */
  addCounts(
    batchId: string,
    counts: { succeeded: number; failed: number; skipped: number }
  ): Promise<BatchJobRecord | undefined>;
  /** 'running' → `status`, stamping `finishedAt`; only the one caller that flipped it gets the row. */
  finishRunning(batchId: string, status: string): Promise<BatchJobRecord | undefined>;

  insertItem(batchId: string, item: NewBatchJobItem): Promise<BatchJobItemRecord>;
  getItem(itemId: string): Promise<BatchJobItemRecord | undefined>;
  /** 'pending' → 'processing'. */
  claimItem(itemId: string): Promise<BatchJobItemRecord | undefined>;
  /** Write an item's outcome (status, result, error), whatever it held before. */
  setItemOutcome(
    itemId: string,
    outcome: { status: string; result: unknown; error: string | null }
  ): Promise<void>;
  /** A batch's items, oldest first (ties by id). `limit` 0 or left out is no limit. */
  listItems(
    batchId: string,
    options?: { status?: string; limit?: number }
  ): Promise<BatchJobItemRecord[]>;
}
