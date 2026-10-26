'use client';

/**
 * The OCR part of a file's details: the button that asks for a read of a
 * scan or image, and while a read is in flight, how far it has got and how
 * long the estimate says it has left. The estimate counts down between the
 * page's own refreshes, so the time moves every second.
 */

import { useEffect, useState } from 'react';
import { chatClient } from '@/lib/chat/client';
import type { LibraryItem } from '@/lib/chat/artifact-library';
import { MIN_SAMPLES } from '@/lib/chat/artifact-ocr-estimate';
import { isPicture } from './artifact-bits';

/** A file OCR can read that has no text yet, and no read in flight. */
export function canRunOcr(item: LibraryItem): boolean {
  return item.ocrSupported && item.ocr === null;
}

/** OCR has read the file already: its text is there, and a read again replaces it. */
function alreadyRead(item: LibraryItem): boolean {
  return item.extractStatus === 'done';
}

/** “45 s”, “2 min”, “1 min 12 s”. */
export function durationLabel(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}

export default function OcrPanel({
  item,
  digests,
  onStart,
}: {
  item: LibraryItem;
  /** Whether the organization writes summaries, which is what search reads. */
  digests: boolean;
  onStart: (item: LibraryItem) => Promise<void>;
}) {
  // The server's snapshot of the run, and when this copy of it was made.
  // The page refreshes it every few seconds; the clock between is local.
  const [mountedAt] = useState(() => Date.now());
  const [now, setNow] = useState(mountedAt);
  const [busy, setBusy] = useState(false);
  const running = item.ocr;

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  if (running) {
    const sinceSnapshot = now - mountedAt;
    const elapsed = running.elapsedMs + sinceSnapshot;
    const { estimate } = running;
    const remaining =
      estimate.remainingMs === null ? null : Math.max(0, estimate.remainingMs - sinceSnapshot);
    const percent =
      estimate.totalMs && estimate.totalMs > 0
        ? Math.min(95, (elapsed / estimate.totalMs) * 100)
        : null;
    return (
      <section aria-label="OCR" className="border-t border-gray-100 px-4 py-3 dark:border-gray-900">
        <h3 className="mb-2 text-xs font-semibold text-gray-500">OCR</h3>
        {running.stalled ? (
          <>
            <p className="text-sm text-amber-700 dark:text-amber-400">
              This read has not reported back in over 15 minutes.
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void onStart(item).finally(() => setBusy(false));
              }}
              className="mt-2 rounded-md border border-gray-300 px-2 py-1 text-xs hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-900"
            >
              Start it again
            </button>
          </>
        ) : (
          <>
            <div
              role="progressbar"
              aria-label="OCR progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent === null ? undefined : Math.round(percent)}
              className="h-2 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-800"
            >
              {percent === null ? (
                <div className="h-full w-1/3 animate-pulse rounded-full bg-blue-400" />
              ) : (
                <div
                  className="h-full bg-blue-600 transition-[width] duration-1000"
                  style={{ width: `${percent}%` }}
                />
              )}
            </div>
            <p className="mt-2 text-sm">Reading the scan · {durationLabel(elapsed)} so far</p>
            <p className="mt-1 text-xs text-gray-500">
              {estimate.overdue
                ? `Taking longer than the ${estimate.basedOn} similar files before it.`
                : remaining !== null
                  ? `About ${durationLabel(remaining)} left, from ${estimate.basedOn} similar files.`
                  : `No estimate yet: it needs ${MIN_SAMPLES} finished reads of similar files, and there are ${estimate.basedOn} so far.`}
            </p>
          </>
        )}
      </section>
    );
  }

  if (canRunOcr(item)) {
    const read = alreadyRead(item);
    return (
      <section aria-label="OCR" className="border-t border-gray-100 px-4 py-3 dark:border-gray-900">
        <h3 className="mb-2 text-xs font-semibold text-gray-500">OCR</h3>
        {item.ocrPages !== null ? (
          <p className="mb-1 text-sm text-gray-700 dark:text-gray-300">
            Read {item.ocrPages} {item.ocrPages === 1 ? 'page' : 'pages'} by OCR.
          </p>
        ) : null}
        {read ? (
          <a
            href={chatClient.attachmentTextUrl(item.id)}
            download
            className="mb-1 inline-block text-sm text-blue-600 hover:underline dark:text-blue-400"
          >
            Download the text
          </a>
        ) : null}
        <p className="text-sm text-gray-700 dark:text-gray-300">
          {read
            ? 'The full text is read. A read again replaces it with a fresh OCR of the file.'
            : isPicture(item.contentType)
              ? 'OCR reads any text in this picture. Its description is written from the picture itself.'
              : 'OCR reads the full text of this file, for the assistant and for people, including scans and pages a text layer misses.'}
        </p>
        {!digests ? (
          <p className="mt-1 text-xs text-gray-500">
            Summaries and descriptions are off for this organization, so search will not find this
            file by its content until they are on (Admin → Settings).
          </p>
        ) : null}
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void onStart(item).finally(() => setBusy(false));
          }}
          className="mt-2 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {read
            ? 'Read again with OCR'
            : item.extractStatus === 'ocr_failed'
              ? 'Try OCR again'
              : 'Run OCR'}
        </button>
      </section>
    );
  }

  return null;
}
