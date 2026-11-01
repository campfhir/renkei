'use client';

/**
 * A small pill for a toolbar that says uploads are running — "Uploading
 * 3 of 10" over a thin bar — and, once they are done, how many failed
 * until that is looked at. Clicking it opens every batch the queue
 * holds (upload-queue.tsx), each as the live table (upload-table.tsx),
 * with Retry on what failed, Stop on what is still going and Dismiss on
 * what is finished. Nothing is rendered while the queue is empty, so it
 * costs a toolbar nothing to carry one. Any toolbar may: the chat's
 * title bar does.
 */

import { useEffect, useState } from 'react';
import Modal from '@/components/modal';
import { Icon, ICONS } from '@/components/icons';
import { Spinner } from '@/components/skeleton';
import UploadTable, { type UploadFilter } from './upload-table';
import { useOptionalUploadQueue } from './upload-queue';
import { indicatorView, isBatchFinished, type UploadBatch } from './upload-queue.model';

export default function UploadIndicator({
  className = '',
  compact = false,
}: {
  className?: string;
  /** A phone's title bar: the count alone ("3/8"), the words in the tooltip. */
  compact?: boolean;
}) {
  const queue = useOptionalUploadQueue();
  const [open, setOpen] = useState(false);
  const view = queue ? indicatorView(queue.batches) : null;
  const empty = view === null;
  // The last batch dismissed closes the dialog for good: the pill is gone
  // with it, and the next batch must not find the dialog already open.
  useEffect(() => {
    if (empty) setOpen(false);
  }, [empty]);
  if (!view) return null;
  const { running, label, percent } = view;
  const shown = compact ? view.compact : label;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`${label}. Open the uploads.`}
        title={label}
        data-testid="upload-indicator"
        className={`flex h-8 items-center gap-1.5 rounded-md border px-2 text-xs font-medium ${
          view.failed
            ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300'
            : 'border-gray-300 text-gray-700 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-900'
        } ${className}`}
      >
        {running ? (
          <Spinner size={3} />
        ) : (
          <Icon path={view.failed ? ICONS.close : ICONS.check} className="h-3.5 w-3.5 shrink-0" />
        )}
        <span className="flex flex-col items-start leading-none">
          <span>{shown}</span>
          {running ? (
            <span
              role="progressbar"
              aria-label="Upload progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(percent)}
              className={`mt-1 block h-0.5 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-800 ${compact ? 'min-w-6' : 'min-w-16'}`}
            >
              <span
                className="block h-full bg-blue-600 transition-[width]"
                style={{ width: `${percent}%` }}
              />
            </span>
          ) : null}
        </span>
      </button>
      {open ? <UploadsModal onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/** Every batch the queue holds, newest first. */
function UploadsModal({ onClose }: { onClose: () => void }) {
  const queue = useOptionalUploadQueue();
  const batches = queue ? [...queue.batches].reverse() : [];
  return (
    <Modal title="Uploads" onClose={onClose} size="lg">
      {batches.length === 0 ? (
        <p className="text-sm text-gray-500">Nothing is uploading.</p>
      ) : (
        <div className="max-h-[65vh] space-y-4 overflow-y-auto">
          {batches.map((batch) => (
            <BatchPanel key={batch.id} batch={batch} />
          ))}
        </div>
      )}
      <div className="mt-3 flex justify-end">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900"
        >
          Done
        </button>
      </div>
    </Modal>
  );
}

function BatchPanel({ batch }: { batch: UploadBatch }) {
  const queue = useOptionalUploadQueue();
  const [filter, setFilter] = useState<UploadFilter>('all');
  const finished = isBatchFinished(batch);
  return (
    <section
      aria-label={batch.title}
      className="rounded-lg border border-gray-200 p-3 dark:border-gray-800"
    >
      <div className="mb-2 flex items-center gap-2">
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">{batch.title}</h3>
        {finished ? (
          <button
            type="button"
            onClick={() => queue?.dismiss(batch.id)}
            className="text-xs font-medium text-gray-600 hover:underline dark:text-gray-400"
          >
            Dismiss
          </button>
        ) : (
          <button
            type="button"
            onClick={() => queue?.cancel(batch.id)}
            className="text-xs font-medium text-red-600 hover:underline dark:text-red-400"
          >
            Stop
          </button>
        )}
      </div>
      <UploadTable
        batch={batch}
        filter={filter}
        onFilter={setFilter}
        onRetry={(job) => queue?.retry(batch.id, job.id)}
      />
    </section>
  );
}
