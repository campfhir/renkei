/**
 * The app-wide upload queue (upload-queue.tsx), the table a batch is shown
 * as (upload-table.tsx) and the title bar's pill (upload-indicator.tsx).
 *
 * The provider holds the files, runs the sends, aborts them and keeps
 * the clear-after timer; what each file's row says at every step, which
 * file goes next, what a retry or a stop does to the rows, when a batch
 * clears itself, and what the table and the pill say about it all are
 * here, tested in upload-queue.model.test.ts. Ids and the start time come
 * in on the action.
 */

export type UploadStatus = 'queued' | 'uploading' | 'done' | 'failed' | 'cancelled';

export type UploadOutcome = { ok: true } | { ok: false; error: string };

export interface UploadJob {
  id: string;
  name: string;
  size: number;
  label: string;
  status: UploadStatus;
  /** Bytes sent so far. */
  loaded: number;
  error: string | null;
}

export interface UploadBatch {
  id: string;
  /** What the batch is, for the indicator and its dialog: "Add files to acme/billing". */
  title: string;
  /** Where the files go, in a word: "checkout", "artifacts". */
  destination: string;
  jobs: UploadJob[];
  startedAt: number;
}

export type UploadFilter = 'all' | 'failed';

export type QueueAction =
  | {
      type: 'enqueued';
      id: string;
      title: string;
      destination: string;
      startedAt: number;
      jobs: { id: string; name: string; size: number; label: string }[];
    }
  | { type: 'started'; batchId: string; jobId: string }
  | { type: 'progressed'; batchId: string; jobId: string; loaded: number }
  /** A send answered; `aborted` when it was stopped on the way. */
  | { type: 'finished'; batchId: string; jobId: string; outcome: UploadOutcome; aborted: boolean }
  /** The file to send is no longer held (the batch was dismissed under it). */
  | { type: 'lost'; batchId: string; jobId: string }
  | { type: 'retried'; batchId: string; jobId: string }
  /** Stop: queued files never start (in-flight ones answer as aborted). */
  | { type: 'cancelled'; batchId: string }
  | { type: 'dismissed'; batchId: string };

function patch(
  batches: UploadBatch[],
  batchId: string,
  jobId: string,
  change: (job: UploadJob) => UploadJob
): UploadBatch[] {
  return batches.map((batch) =>
    batch.id === batchId
      ? { ...batch, jobs: batch.jobs.map((job) => (job.id === jobId ? change(job) : job)) }
      : batch
  );
}

export function queueReducer(batches: UploadBatch[], action: QueueAction): UploadBatch[] {
  switch (action.type) {
    case 'enqueued':
      return [
        ...batches,
        {
          id: action.id,
          title: action.title,
          destination: action.destination,
          startedAt: action.startedAt,
          jobs: action.jobs.map((job) => ({
            ...job,
            status: 'queued',
            loaded: 0,
            error: null,
          })),
        },
      ];
    case 'started':
      return patch(batches, action.batchId, action.jobId, (job) => ({
        ...job,
        status: 'uploading',
        loaded: 0,
        error: null,
      }));
    case 'progressed':
      return patch(batches, action.batchId, action.jobId, (job) => ({
        ...job,
        loaded: action.loaded,
      }));
    case 'finished':
      return patch(batches, action.batchId, action.jobId, (job) =>
        action.aborted
          ? { ...job, status: 'cancelled', error: 'Cancelled.' }
          : action.outcome.ok
            ? { ...job, status: 'done', loaded: job.size, error: null }
            : { ...job, status: 'failed', error: action.outcome.error }
      );
    case 'lost':
      return patch(batches, action.batchId, action.jobId, (job) => ({
        ...job,
        status: 'failed',
        error: 'The file is gone.',
      }));
    case 'retried':
      return patch(batches, action.batchId, action.jobId, (job) => ({
        ...job,
        status: 'queued',
        loaded: 0,
        error: null,
      }));
    case 'cancelled':
      return batches.map((batch) =>
        batch.id === action.batchId
          ? {
              ...batch,
              jobs: batch.jobs.map((job) =>
                job.status === 'queued' ? { ...job, status: 'cancelled', error: 'Cancelled.' } : job
              ),
            }
          : batch
      );
    case 'dismissed':
      return batches.filter((batch) => batch.id !== action.batchId);
  }
}

/** What a thrown send means for its row. */
export function thrownOutcome(error: unknown): UploadOutcome {
  if (error instanceof Error && error.name === 'AbortError')
    return { ok: false, error: 'Cancelled.' };
  return { ok: false, error: error instanceof Error ? error.message : 'The upload failed.' };
}

/** The next file a lane takes: the first still queued. */
export function nextQueued(batch: UploadBatch | undefined): UploadJob | null {
  return batch?.jobs.find((job) => job.status === 'queued') ?? null;
}

export function isFailed(job: UploadJob): boolean {
  return job.status === 'failed' || job.status === 'cancelled';
}

/** Counts a batch has: what is left to do, what failed. */
export function batchProgress(batch: UploadBatch): {
  total: number;
  done: number;
  failed: number;
  pending: number;
  loaded: number;
  bytes: number;
} {
  let done = 0;
  let failed = 0;
  let pending = 0;
  let loaded = 0;
  let bytes = 0;
  for (const job of batch.jobs) {
    bytes += job.size;
    if (job.status === 'done') {
      done += 1;
      loaded += job.size;
    } else if (isFailed(job)) failed += 1;
    else {
      pending += 1;
      loaded += Math.min(job.loaded, job.size);
    }
  }
  return { total: batch.jobs.length, done, failed, pending, loaded, bytes };
}

export function isBatchFinished(batch: UploadBatch): boolean {
  return batch.jobs.every((job) => job.status !== 'queued' && job.status !== 'uploading');
}

/** A finished batch with nothing failed clears itself; one with failures waits to be read. */
export function clearsItself(batch: UploadBatch): boolean {
  return isBatchFinished(batch) && batchProgress(batch).failed === 0;
}

/** Files queued or uploading, across every batch. */
export function activeCount(batches: UploadBatch[]): number {
  return batches.reduce(
    (sum, batch) =>
      sum +
      batch.jobs.filter((job) => job.status === 'queued' || job.status === 'uploading').length,
    0
  );
}

function percentOf(loaded: number, bytes: number): number {
  return bytes > 0 ? Math.min(100, (loaded / bytes) * 100) : 0;
}

/** What the table above a batch's rows says, and which rows it shows. */
export function tableView(
  batch: UploadBatch,
  filter: UploadFilter
): {
  status: string;
  failedLabel: string;
  /** null once nothing is left to send: no bar. */
  percent: number | null;
  rows: UploadJob[];
  empty: string | null;
} {
  const progress = batchProgress(batch);
  const rows = filter === 'failed' ? batch.jobs.filter(isFailed) : batch.jobs;
  return {
    status:
      progress.pending > 0
        ? `${progress.done} of ${progress.total} uploaded`
        : progress.failed > 0
          ? `${progress.done} of ${progress.total} uploaded · ${progress.failed} failed`
          : `All ${progress.total} uploaded`,
    failedLabel: `Failed${progress.failed > 0 ? ` (${progress.failed})` : ''}`,
    percent: progress.pending > 0 ? percentOf(progress.loaded, progress.bytes) : null,
    rows,
    empty: rows.length > 0 ? null : filter === 'failed' ? 'Nothing failed.' : 'No files.',
  };
}

/** One row's state, in words, and how far its bar is. */
export function rowView(job: UploadJob): {
  percent: number;
  state: 'Queued' | 'Uploading' | 'Added' | 'Failed' | 'Stopped';
  retry: boolean;
  error: string | null;
} {
  const percent = percentOf(job.loaded, job.size);
  const state =
    job.status === 'queued'
      ? 'Queued'
      : job.status === 'uploading'
        ? 'Uploading'
        : job.status === 'done'
          ? 'Added'
          : job.status === 'cancelled'
            ? 'Stopped'
            : 'Failed';
  return {
    percent,
    state,
    retry: isFailed(job),
    error: isFailed(job) ? job.error : null,
  };
}

/** The title bar's pill: null while the queue is empty. */
export function indicatorView(batches: UploadBatch[]): {
  running: boolean;
  /** The full words, the pill's name and tooltip. */
  label: string;
  /** What a phone's narrow pill shows. */
  compact: string;
  percent: number;
  failed: boolean;
} | null {
  if (batches.length === 0) return null;
  const totals = batches.map(batchProgress).reduce(
    (sum, progress) => ({
      total: sum.total + progress.total,
      done: sum.done + progress.done,
      failed: sum.failed + progress.failed,
      loaded: sum.loaded + progress.loaded,
      bytes: sum.bytes + progress.bytes,
    }),
    { total: 0, done: 0, failed: 0, loaded: 0, bytes: 0 }
  );
  const running = activeCount(batches) > 0;
  const current = Math.min(totals.done + 1, totals.total);
  return {
    running,
    label: running
      ? `Uploading ${current} of ${totals.total}`
      : totals.failed > 0
        ? `${totals.failed} upload${totals.failed === 1 ? '' : 's'} failed`
        : `Uploaded ${totals.total}`,
    compact: running
      ? `${current}/${totals.total}`
      : totals.failed > 0
        ? `${totals.failed} failed`
        : `${totals.total}`,
    percent: percentOf(totals.loaded, totals.bytes),
    failed: !running && totals.failed > 0,
  };
}

export function sizeLabel(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1_048_576) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / 1_048_576).toFixed(1)} MB`;
}
