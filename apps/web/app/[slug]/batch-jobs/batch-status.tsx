/**
 * Human wording and color for batch_jobs/batch_job_items statuses — the
 * batch-jobs twin of @/lib/agents/run-labels.ts and the agents run
 * timeline's StatusPill. Covers both a batch's own statuses (queued,
 * discovering, running, succeeded, partial, failed, canceled — see
 * docs/batch-jobs-design.md) and an item's (pending, processing,
 * succeeded, failed) in one map since neither set collides.
 */

const STATUS_LABELS: Record<string, string> = {
  queued: 'Queued',
  discovering: 'Discovering',
  running: 'Running',
  pending: 'Pending',
  processing: 'Processing',
  succeeded: 'Succeeded',
  // A batch that finished with a mix of successes and failures — neither
  // the green of a clean run nor the red of a total loss.
  partial: 'Partially succeeded',
  failed: 'Failed',
  canceled: 'Canceled',
};

export function batchStatusLabel(status: string): string {
  return STATUS_LABELS[status] ?? (status ? status.charAt(0).toUpperCase() + status.slice(1) : status);
}

function statusTone(status: string): string {
  switch (status) {
    case 'succeeded':
      return 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300';
    case 'partial':
      return 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300';
    case 'failed':
      return 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300';
    case 'running':
    case 'discovering':
    case 'processing':
      return 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300';
    default:
      // queued, pending, canceled
      return 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400';
  }
}

export function BatchStatusPill({ status }: { status: string }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusTone(status)}`}>
      {batchStatusLabel(status)}
    </span>
  );
}

/** "12/40 (11 ok, 1 failed)", or "discovering…" before totals are known. */
export function batchProgress(batch: {
  total: number | null;
  succeeded: number;
  failed: number;
}): string {
  if (batch.total === null) return 'discovering…';
  return `${batch.succeeded + batch.failed}/${batch.total} (${batch.succeeded} ok, ${batch.failed} failed)`;
}
