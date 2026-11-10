'use client';

/**
 * Files into a code project, from its chat's title bar: picked or
 * dropped, then sent to one of two places the person chooses — the
 * repository's checkout, each at its name under an optional folder, as
 * an untracked file the chat's tools then see (git status lists it, the
 * diff shows it, a commit can take it); or the project's artifacts, the
 * files every chat in the project can read without them being part of
 * the repository.
 *
 * Two screens in one dialog. Choosing: the destination, the folder, and
 * the files so far in a list that scrolls on its own, so the buttons
 * stay put however many files are added. Uploading: the same files as a
 * live table (components/uploads/upload-table.tsx) — a bar per file
 * while it goes, then Added or why not, with Failed narrowing the rows
 * to the failures. The sends themselves run in the app-wide queue
 * (upload-queue.tsx): closing the dialog, or moving to another page,
 * leaves them running, and the title bar's indicator shows them; a
 * reload is asked about first. `onUploaded` fires as each file lands in
 * the checkout so the tree beside the chat reads the folder again.
 *
 * What a pick adds, each file's path, the button's words and the batch
 * Add sends are add-files-modal.model.ts.
 */

import { useReducer, useRef, useState, type DragEvent } from 'react';
import { useRouter } from 'next/navigation';
import Modal from '@/components/modal';
import { Icon, ICONS } from '@/components/icons';
import { chatClient } from '@/lib/chat/client';
import { reportFetchFailure } from '@/lib/fetch-json';
import { uploadFile } from '@/lib/upload-file';
import UploadTable, { sizeLabel } from '@/components/uploads/upload-table';
import { useUploadQueue, type UploadSender } from '@/components/uploads/upload-queue';
import {
  addFilesReducer,
  addLabel,
  batchPlan,
  canAdd,
  countLabel,
  initialAddFiles,
  listedAs,
} from './add-files-modal.model';

export type { AddFilesDestination } from './add-files-modal.model';
export { checkoutPath } from './add-files-modal.model';

const inputClass =
  'w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900';

/** Puts a file at `path` in the checkout behind `filesBase` (`…/files`). */
export function checkoutSender(filesBase: string, path: string): UploadSender {
  return async (file, report, signal) => {
    const url = `${filesBase}?path=${encodeURIComponent(path)}`;
    let response;
    try {
      response = await uploadFile(url, file, { method: 'PUT', onProgress: report, signal });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      reportFetchFailure('PUT', filesBase, 0, 'Could not reach the server', error);
      return { ok: false, error: 'Could not reach the server.' };
    }
    if (response.status >= 200 && response.status < 300) return { ok: true };
    const body = response.body;
    const message =
      typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string'
        ? body.error
        : `Not added (${response.status}).`;
    reportFetchFailure('PUT', filesBase, response.status, message);
    return { ok: false, error: message };
  };
}

/** Keeps a file as one of the project's artifacts. */
export function artifactSender(projectId: string): UploadSender {
  return async (file, report) => {
    const result = await chatClient.uploadArtifact({ projectId }, file, report);
    if (result.error || !result.data) return { ok: false, error: result.error ?? 'Not added.' };
    return { ok: true };
  };
}

export default function AddFilesModal({
  base,
  projectId,
  projectName,
  onClose,
  onUploaded,
}: {
  /** The chat's checkout routes (`codeProjectUrl(projectId, chatId)`). */
  base: string;
  projectId: string;
  projectName: string;
  onClose: () => void;
  /** A file landed in the checkout at this path. */
  onUploaded?: (path: string) => void;
}) {
  const queue = useUploadQueue();
  const router = useRouter();
  const [state, dispatch] = useReducer(addFilesReducer<File>, undefined, initialAddFiles<File>);
  const { destination, folder, files, batchId, filter } = state;
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const take = (list: FileList | File[] | null) => {
    if (list) dispatch({ type: 'picked', files: [...list] });
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    take(event.dataTransfer.files);
  };

  const start = () => {
    if (!canAdd(state)) return;
    const plan = batchPlan(state, projectName);
    const toCheckout = plan.destination === 'checkout';
    const id = queue.enqueue({
      title: plan.title,
      destination: plan.destination,
      items: plan.items.map(({ file, label, path }) => ({
        file,
        label,
        send: toCheckout ? checkoutSender(`${base}/files`, path) : artifactSender(projectId),
      })),
      onItem: (job) => {
        if (job.status === 'done' && toCheckout) onUploaded?.(job.label);
      },
      onDone: () => {
        // The project page's Artifacts card is server data.
        if (!toCheckout) router.refresh();
      },
    });
    dispatch({ type: 'started', batchId: id });
  };

  const batch = batchId ? (queue.batches.find((entry) => entry.id === batchId) ?? null) : null;

  const footerButton =
    'rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900';

  if (batchId) {
    return (
      <Modal title="Add files" onClose={onClose}>
        <div className="flex max-h-[70vh] flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            {batch ? (
              <UploadTable
                batch={batch}
                filter={filter}
                onFilter={(next) => dispatch({ type: 'filter', filter: next })}
                onRetry={(job) => queue.retry(batch.id, job.id)}
              />
            ) : (
              <p className="text-sm text-gray-500">Done — every file was added.</p>
            )}
          </div>
          <div className="mt-3 flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-gray-200 pt-3 dark:border-gray-800">
            {queue.active > 0 ? (
              // Its own line on a phone, beside the buttons where there is room.
              <p className="basis-full text-xs text-gray-500 sm:mr-auto sm:basis-auto">
                Closing this keeps the upload going; the title bar shows it.
              </p>
            ) : null}
            <button
              type="button"
              onClick={() => dispatch({ type: 'addMore' })}
              className={footerButton}
            >
              Add more
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
            >
              Done
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Add files" onClose={onClose}>
      <div className="flex max-h-[70vh] flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          <fieldset className="mb-3">
            <legend className="mb-1 text-xs font-medium text-gray-500">Where they go</legend>
            <label className="flex cursor-pointer items-start gap-2 py-0.5 text-sm">
              <input
                type="radio"
                name="add-files-destination"
                checked={destination === 'checkout'}
                onChange={() => dispatch({ type: 'destination', destination: 'checkout' })}
                className="mt-1"
              />
              <span>
                <span className="font-medium">The repository’s checkout</span>
                <span className="block text-xs text-gray-500">
                  They land as untracked files the chat can read, use and commit — ask it to once
                  they are in.
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-2 py-0.5 text-sm">
              <input
                type="radio"
                name="add-files-destination"
                checked={destination === 'artifacts'}
                onChange={() => dispatch({ type: 'destination', destination: 'artifacts' })}
                className="mt-1"
              />
              <span>
                <span className="font-medium">The project’s artifacts</span>
                <span className="block text-xs text-gray-500">
                  Kept beside the project for every chat in it to read; not part of the repository.
                </span>
              </span>
            </label>
          </fieldset>
          <div
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            onClick={() => input.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') input.current?.click();
            }}
            aria-label="Drop files here or choose files"
            className={`flex cursor-pointer flex-col items-center justify-center gap-1 rounded-md border-2 border-dashed px-3 py-6 text-center text-sm ${
              dragging
                ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/40'
                : 'border-gray-300 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-900'
            }`}
          >
            <Icon path={ICONS.upload} className="h-5 w-5 text-gray-400" />
            <span>Drop files here, or click to choose</span>
            <input
              ref={input}
              type="file"
              multiple
              className="hidden"
              onChange={(event) => {
                take(event.target.files);
                event.target.value = '';
              }}
            />
          </div>
          {destination === 'checkout' ? (
            <label className="mt-3 block text-sm">
              <span className="mb-1 block text-xs font-medium text-gray-500">
                Folder (optional)
              </span>
              <input
                value={folder}
                onChange={(event) => dispatch({ type: 'folder', folder: event.target.value })}
                placeholder="docs/assets"
                autoComplete="off"
                spellCheck={false}
                className={`font-mono ${inputClass}`}
              />
            </label>
          ) : null}
          {files.length > 0 ? (
            <ul
              className="mt-3 divide-y divide-gray-200 text-sm dark:divide-gray-800"
              aria-label="Files to add"
            >
              {files.map((file) => (
                <li key={file.name} className="flex items-center gap-2 py-1">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">
                    {listedAs(state, file.name)}
                  </span>
                  <span className="text-xs text-gray-500">{sizeLabel(file.size)}</span>
                  <button
                    type="button"
                    onClick={() => dispatch({ type: 'removed', file })}
                    className="text-xs text-gray-500 hover:underline"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <div className="mt-3 flex shrink-0 items-center justify-end gap-2 border-t border-gray-200 pt-3 dark:border-gray-800">
          {countLabel(state) ? (
            <span className="mr-auto text-xs text-gray-500">{countLabel(state)}</span>
          ) : null}
          <button type="button" onClick={onClose} className={footerButton}>
            Cancel
          </button>
          <button
            type="button"
            disabled={!canAdd(state)}
            onClick={start}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {addLabel(state)}
          </button>
        </div>
      </div>
    </Modal>
  );
}
