'use client';

/**
 * A batch's files as a table, live: each row says where its file goes
 * and how far it has got — queued, a bar while it uploads, a tick once
 * it has landed, or why it failed, with a way to send it again. The
 * summary line above counts what is done and what failed, and "Failed"
 * narrows the rows to the failures so their reasons can be read
 * without scrolling past what worked. Shared by the dialog an upload
 * starts from and the one the title bar's indicator opens.
 */

import { Icon, ICONS } from '@/components/icons';
import { Spinner } from '@/components/skeleton';
import { batchProgress, type UploadBatch, type UploadJob } from './upload-queue';

export type UploadFilter = 'all' | 'failed';

export function sizeLabel(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1_048_576) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / 1_048_576).toFixed(1)} MB`;
}

export default function UploadTable({
  batch,
  filter,
  onFilter,
  onRetry,
}: {
  batch: UploadBatch;
  filter: UploadFilter;
  onFilter: (filter: UploadFilter) => void;
  onRetry?: (job: UploadJob) => void;
}) {
  const progress = batchProgress(batch);
  const rows = filter === 'failed' ? batch.jobs.filter((job) => isFailed(job)) : batch.jobs;
  const percent = progress.bytes > 0 ? Math.min(100, (progress.loaded / progress.bytes) * 100) : 0;
  const filterButton = (value: UploadFilter, label: string) => (
    <button
      type="button"
      onClick={() => onFilter(value)}
      aria-pressed={filter === value}
      className={`rounded-md px-2 py-0.5 text-xs font-medium ${
        filter === value
          ? 'bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900'
          : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
      }`}
    >
      {label}
    </button>
  );
  return (
    <div className="flex min-h-0 flex-col" data-testid="upload-table">
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-600 dark:text-gray-400">
        <span role="status" aria-live="polite">
          {progress.pending > 0
            ? `${progress.done} of ${progress.total} uploaded`
            : progress.failed > 0
              ? `${progress.done} of ${progress.total} uploaded · ${progress.failed} failed`
              : `All ${progress.total} uploaded`}
        </span>
        <span className="ml-auto flex items-center gap-1" role="group" aria-label="Show">
          {filterButton('all', 'All')}
          {filterButton('failed', `Failed${progress.failed > 0 ? ` (${progress.failed})` : ''}`)}
        </span>
      </div>
      {progress.pending > 0 ? (
        <div
          role="progressbar"
          aria-label="Upload progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(percent)}
          className="mb-2 h-1.5 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-800"
        >
          <div className="h-full bg-blue-600 transition-[width]" style={{ width: `${percent}%` }} />
        </div>
      ) : null}
      {rows.length === 0 ? (
        <p className="py-3 text-center text-xs text-gray-500">
          {filter === 'failed' ? 'Nothing failed.' : 'No files.'}
        </p>
      ) : (
        <ul className="divide-y divide-gray-200 text-sm dark:divide-gray-800" aria-label="Files">
          {rows.map((job) => (
            <UploadRow key={job.id} job={job} onRetry={onRetry} />
          ))}
        </ul>
      )}
    </div>
  );
}

function isFailed(job: UploadJob): boolean {
  return job.status === 'failed' || job.status === 'cancelled';
}

function UploadRow({ job, onRetry }: { job: UploadJob; onRetry?: (job: UploadJob) => void }) {
  const percent = job.size > 0 ? Math.min(100, (job.loaded / job.size) * 100) : 0;
  return (
    <li className="flex items-start gap-2 py-1.5" data-status={job.status}>
      <Icon path={ICONS.file} className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono text-xs" title={job.label}>
          {job.label}
        </span>
        {job.status === 'uploading' ? (
          <span
            role="progressbar"
            aria-label={`Uploading ${job.name}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(percent)}
            className="mt-1 block h-1 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-800"
          >
            <span
              className="block h-full bg-blue-600 transition-[width]"
              style={{ width: `${percent}%` }}
            />
          </span>
        ) : null}
        {isFailed(job) && job.error ? (
          <span className="mt-0.5 block text-xs text-red-600 dark:text-red-400">{job.error}</span>
        ) : null}
      </span>
      <span className="shrink-0 text-xs text-gray-500">{sizeLabel(job.size)}</span>
      <span className="flex w-20 shrink-0 items-center justify-end gap-1 text-xs">
        {job.status === 'queued' ? (
          <span className="text-gray-400">Queued</span>
        ) : job.status === 'uploading' ? (
          <>
            <Spinner size={3} />
            <span className="text-gray-500">{Math.round(percent)}%</span>
          </>
        ) : job.status === 'done' ? (
          <span className="flex items-center gap-1 text-green-700 dark:text-green-400">
            <Icon path={ICONS.check} className="h-3.5 w-3.5" />
            Added
          </span>
        ) : (
          <>
            <span className="flex items-center gap-1 text-red-600 dark:text-red-400">
              <Icon path={ICONS.close} className="h-3.5 w-3.5" />
              {job.status === 'cancelled' ? 'Stopped' : 'Failed'}
            </span>
            {onRetry ? (
              <button
                type="button"
                onClick={() => onRetry(job)}
                aria-label={`Retry ${job.name}`}
                className="font-medium text-blue-600 hover:underline dark:text-blue-400"
              >
                Retry
              </button>
            ) : null}
          </>
        )}
      </span>
    </li>
  );
}
