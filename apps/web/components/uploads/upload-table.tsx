'use client';

/**
 * A batch's files as a table, live: each row says where its file goes
 * and how far it has got — queued, a bar while it uploads, a tick once
 * it has landed, or why it failed, with a way to send it again. The
 * summary line above counts what is done and what failed, and "Failed"
 * narrows the rows to the failures so their reasons can be read
 * without scrolling past what worked. Shared by the dialog an upload
 * starts from and the one the title bar's indicator opens. What the
 * summary and each row say is upload-queue.model.ts (`tableView`,
 * `rowView`).
 */

import { Icon, ICONS } from '@/components/icons';
import { Spinner } from '@/components/skeleton';
import {
  rowView,
  tableView,
  type UploadBatch,
  type UploadFilter,
  type UploadJob,
} from './upload-queue.model';

export type { UploadFilter } from './upload-queue.model';
export { sizeLabel } from './upload-queue.model';
import { sizeLabel } from './upload-queue.model';

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
  const view = tableView(batch, filter);
  const { rows, percent } = view;
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
          {view.status}
        </span>
        <span className="ml-auto flex items-center gap-1" role="group" aria-label="Show">
          {filterButton('all', 'All')}
          {filterButton('failed', view.failedLabel)}
        </span>
      </div>
      {percent !== null ? (
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
      {view.empty ? (
        <p className="py-3 text-center text-xs text-gray-500">{view.empty}</p>
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

function UploadRow({ job, onRetry }: { job: UploadJob; onRetry?: (job: UploadJob) => void }) {
  const { percent, state, retry, error } = rowView(job);
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
        {error ? (
          <span className="mt-0.5 block text-xs text-red-600 dark:text-red-400">{error}</span>
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
              {state}
            </span>
            {onRetry && retry ? (
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
